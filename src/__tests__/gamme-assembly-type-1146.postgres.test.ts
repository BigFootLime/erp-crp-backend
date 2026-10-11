import { readFileSync } from "node:fs";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { repoPath } from "./helpers/repo-paths";
import { addGammeOperationSchema, updateGammeOperationSchema } from "../module/gammes/validators/gammes.validators";
import { assertOperationResourceCompatible } from "../module/planning/repository/planning.repository";
import { OF_ASSEMBLY_OPERATIONS_SQL } from "../module/production/repository/of-component-coverage.sql";

// This suite only creates tables in the dedicated, opt-in disposable runner database.
const url = process.env.CERP_ASSEMBLY_TYPE_PG_URL;
const enabled = Boolean(url && process.env.CERP_E2E_ISOLATED === "1" &&
  new URL(url).pathname === "/gamme_assembly_type_1146" && new URL(url).port === "55432");
const describePg = enabled ? describe : describe.skip;
const patch = "20261011_gamme_assembly_operation_type_1146";
const migration = readFileSync(repoPath("db", "patches", patch + ".sql"), "utf8");
const rollback = readFileSync(repoPath("db", "patches", "support", patch + ".rollback.sql"), "utf8");
const verify = readFileSync(repoPath("db", "patches", "support", patch + ".verify.sql"), "utf8");
const legacyTypes = ["TOURNAGE", "FRAISAGE", "DECOUPE", "REPRISE", "CONTROLE", "LAVAGE", "SOUS_TRAITANCE", "EMBALLAGE", "AUTRE"];
const source = "10000000-0000-4000-8000-000000000001";
const operation = "10000000-0000-4000-8000-000000000002";
const poste = "10000000-0000-4000-8000-000000000003";
const piece = "10000000-0000-4000-8000-000000000004";
let db: Client;

describePg("canonical assembly type — PostgreSQL1146", () => {
  beforeAll(async () => {
    if (!enabled) throw Error("Refusing an ERP database");
    db = new Client({ connectionString: url }); await db.connect();
    expect((await db.query("SELECT current_database() AS name")).rows[0].name).toBe("gamme_assembly_type_1146");
    await db.query(`
      CREATE TABLE public.pieces_techniques_operations(id uuid PRIMARY KEY, type_operation text, designation text, phase integer);
      CREATE TABLE public.machines(id uuid PRIMARY KEY, code text, machine_family_code text);
      CREATE TABLE public.postes(id uuid PRIMARY KEY, machine_id uuid, is_active boolean, archived_at timestamptz);
      CREATE TABLE public.ordres_fabrication(id bigint PRIMARY KEY, piece_technique_id uuid, technical_snapshot jsonb);
      CREATE TABLE public.of_revisions(id uuid PRIMARY KEY, statut text);
      CREATE TABLE public.of_operations(id uuid PRIMARY KEY,of_id bigint,phase integer,designation text,status text,revision_id uuid,machine_id uuid,machine_family_code text,poste_id uuid);
    `);
  });
  beforeEach(async () => {
    await db.query("ROLLBACK");
    await db.query(`TRUNCATE public.pieces_techniques_operations,public.of_operations,public.ordres_fabrication,public.of_revisions,public.postes,public.machines;
      ALTER TABLE public.pieces_techniques_operations DROP CONSTRAINT IF EXISTS pieces_techniques_operations_type_operation_check;
      ALTER TABLE public.pieces_techniques_operations ADD CONSTRAINT pieces_techniques_operations_type_operation_check
        CHECK(type_operation IS NULL OR type_operation IN ('TOURNAGE','FRAISAGE','DECOUPE','REPRISE','CONTROLE','LAVAGE','SOUS_TRAITANCE','EMBALLAGE','AUTRE'));`);
  });
  afterAll(async () => { if (db) await db.end(); });

  it("reproduces the actual historical database rejection", async () => {
    await expect(db.query("INSERT INTO public.pieces_techniques_operations(id,type_operation) VALUES($1,'ASSEMBLAGE')",[source]))
      .rejects.toMatchObject({ code: "23514", constraint: "pieces_techniques_operations_type_operation_check" });
    expect((await db.query("SELECT COUNT(*)::int AS n FROM public.pieces_techniques_operations")).rows[0].n).toBe(0);
  });

  it("creates and updates a validated assembly operation after the real patch", async () => {
    await db.query(migration); await db.query(verify);
    const body = addGammeOperationSchema.parse({ body: { designation: "Montage", type_operation: "ASSEMBLAGE", numero_operation: 10 } }).body;
    await db.query("INSERT INTO public.pieces_techniques_operations(id,type_operation,designation,phase) VALUES($1,$2,$3,$4)",
      [source,body.type_operation,body.designation,body.numero_operation]);
    const update = updateGammeOperationSchema.parse({ body: { type_operation: "ASSEMBLAGE", designation: "Montage axe et platine", expected_updated_at: "2026-10-11T03:00:00Z" } }).body;
    await db.query("UPDATE public.pieces_techniques_operations SET type_operation=$2,designation=$3 WHERE id=$1",[source,update.type_operation,update.designation]);
    expect((await db.query("SELECT type_operation,designation,phase FROM public.pieces_techniques_operations WHERE id=$1",[source])).rows[0])
      .toEqual({ type_operation: "ASSEMBLAGE", designation: "Montage axe et platine", phase: 10 });
  });

  it("preserves historical rows, accepts all legacy/null types and remains repeatable", async () => {
    await db.query("INSERT INTO public.pieces_techniques_operations(id,type_operation,designation,phase) VALUES($1,'DECOUPE','Débit existant',30)",[source]);
    const before=(await db.query("SELECT * FROM public.pieces_techniques_operations")).rows;
    await db.query(migration); await db.query(migration); await db.query(verify);
    expect((await db.query("SELECT * FROM public.pieces_techniques_operations")).rows).toEqual(before);
    for(const type of [...legacyTypes,null,"ASSEMBLAGE"]){
      await db.query("INSERT INTO public.pieces_techniques_operations(id,type_operation) VALUES(gen_random_uuid(),$1)",[type]);
    }
    await expect(db.query("INSERT INTO public.pieces_techniques_operations(id,type_operation) VALUES(gen_random_uuid(),'MONTAGE')"))
      .rejects.toMatchObject({ code: "23514" });
  });

  it("refuses narrowing rollback when an assembly exists, without changing it", async () => {
    await db.query(migration);
    await db.query("INSERT INTO public.pieces_techniques_operations(id,type_operation) VALUES($1,'ASSEMBLAGE')",[source]);
    await expect(db.query(rollback)).rejects.toMatchObject({ message: "ASSEMBLY_OPERATION_ROLLBACK_REQUIRES_REVIEW" });
    await db.query("ROLLBACK"); await db.query(verify);
    expect((await db.query("SELECT type_operation FROM public.pieces_techniques_operations WHERE id=$1",[source])).rows[0].type_operation).toBe("ASSEMBLAGE");
  });

  it("can restore the legacy CHECK while no assembly has been registered", async () => {
    await db.query(migration); await db.query(rollback);
    await expect(db.query("INSERT INTO public.pieces_techniques_operations(id,type_operation) VALUES($1,'ASSEMBLAGE')",[source])).rejects.toMatchObject({ code: "23514" });
    await db.query("INSERT INTO public.pieces_techniques_operations(id,type_operation) VALUES($1,'DECOUPE')",[source]);
  });

  async function frozenAssembly() {
    await db.query(migration);
    await db.query("INSERT INTO public.pieces_techniques_operations(id,type_operation,designation,phase) VALUES($1,'ASSEMBLAGE','Montage axe et platine',10)",[source]);
    await db.query(`INSERT INTO public.ordres_fabrication(id,piece_technique_id,technical_snapshot)
      SELECT 1,$2,jsonb_build_object('operations',jsonb_agg(jsonb_build_object('phase',phase,'type_operation',type_operation)))
      FROM public.pieces_techniques_operations WHERE id=$1`,[source,piece]);
    await db.query("INSERT INTO public.postes(id,is_active) VALUES($1,true)",[poste]);
    await db.query("INSERT INTO public.of_operations(id,of_id,phase,designation,status,poste_id) VALUES($1,1,10,'Montage axe et platine','TODO',$2)",[operation,poste]);
  }

  it("matches the existing frozen reader and qualifies its assigned autonomous poste", async () => {
    await frozenAssembly();
    expect((await db.query(OF_ASSEMBLY_OPERATIONS_SQL,[1])).rows).toEqual([{ id: operation,phase:10,label:"Montage axe et platine",status:"TODO" }]);
    await expect(assertOperationResourceCompatible({tx:db,of_operation_id:operation,resource:{machine_id:null,poste_id:poste}})).resolves.toBeUndefined();
    // The canonical source may change later; the reader continues to use the frozen OF definition.
    await db.query("UPDATE public.pieces_techniques_operations SET type_operation='AUTRE' WHERE id=$1",[source]);
    expect((await db.query(OF_ASSEMBLY_OPERATIONS_SQL,[1])).rows).toHaveLength(1);
  });

  it("keeps a missing, inactive, archived or wrong assembly workstation blocked", async () => {
    await frozenAssembly();
    for(const change of ["is_active=false","is_active=true,archived_at=now()"]){
      await db.query("UPDATE public.postes SET "+change+" WHERE id=$1",[poste]);
      await expect(assertOperationResourceCompatible({tx:db,of_operation_id:operation,resource:{machine_id:null,poste_id:poste}}))
        .rejects.toMatchObject({ code:"PLANNING_MANUAL_POSTE_REQUIRED" });
    }
    await db.query("UPDATE public.postes SET is_active=true,archived_at=NULL WHERE id=$1",[poste]);
    await expect(assertOperationResourceCompatible({tx:db,of_operation_id:operation,resource:{machine_id:null,poste_id:null}}))
      .rejects.toMatchObject({ code:"PLANNING_MANUAL_POSTE_REQUIRED" });
    await expect(assertOperationResourceCompatible({tx:db,of_operation_id:operation,resource:{machine_id:null,poste_id:piece}}))
      .rejects.toMatchObject({ code:"PLANNING_MANUAL_POSTE_REQUIRED" });
    await db.query("INSERT INTO public.machines(id,code,machine_family_code) VALUES($1,'TEST-CNC','F')",[source]);
    await db.query("UPDATE public.postes SET machine_id=$2 WHERE id=$1",[poste,source]);
    await expect(assertOperationResourceCompatible({tx:db,of_operation_id:operation,resource:{machine_id:null,poste_id:poste}}))
      .rejects.toMatchObject({ code:"PLANNING_MANUAL_POSTE_REQUIRED" });
  });
});
