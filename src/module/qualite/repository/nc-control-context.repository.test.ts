import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resolveNcControlContext } from "./nc-control-context.repository";

// Never run this DDL or fixture against an ERP database.
const database = "nc_control_context_1143";
const url = process.env.CERP_NC_CONTEXT_PG_URL;
const enabled = Boolean(url && new URL(url).pathname === `/${database}`);
const describePg = enabled ? describe : describe.skip;
const control = "8ed47f65-553e-477d-bd7a-9fc4887193f2";
const lot = "9870c530-ee07-4eb8-aa2c-cdca6166de0e";
const other = "fbd7fa10-53d8-4cd9-b47c-f05f8e31ad3f";
const receipt = "288205ba-f5dd-4305-8db4-74e5f9d417f0";
const supplier = "be8c67b9-aeaa-4c38-8b92-0ea260ea9da4";
let db: Client;

describePg("NC1143 — source du contrôle, PostgreSQL isolé", () => {
  beforeAll(async () => {
    if (!enabled) throw Error("Refusing ERP database");
    db = new Client({ connectionString: url }); await db.connect();
    // Columns taken from the canonical quality patches (legacy + 228).
    await db.query(`CREATE TABLE public.quality_control (
      id uuid PRIMARY KEY, affaire_id bigint, of_id bigint, piece_technique_id uuid,
      operation_id uuid, lot_id uuid, bon_livraison_id uuid, reception_ligne_id uuid,
      fournisseur_id uuid, source_type text, source_id text
    )`);
  });
  beforeEach(async () => {
    await db.query("TRUNCATE public.quality_control");
    await db.query(`INSERT INTO public.quality_control
      (id,lot_id,reception_ligne_id,fournisseur_id,source_type,source_id)
      VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,'LOT',($2::uuid)::text)`, [control, lot, receipt, supplier]);
  });
  afterAll(async () => { if (db) await db.end(); });

  it("reprend lot, réception et fournisseur connus, sans inventer client ni OF", async () => {
    const body = { control_id: control, lot_id: null, description: "Certificat absent", due_date: "2026-10-12" };
    const result = await resolveNcControlContext(db, body);
    expect(result).toMatchObject({ control_id: control, lot_id: lot, reception_ligne_id: receipt, fournisseur_id: supplier, of_id: null, affaire_id: null, piece_technique_id: null, due_date: "2026-10-12" });
    expect(result.client_id).toBeUndefined();
    expect(body.lot_id).toBeNull();
  });
  it.each(["lot_id", "reception_ligne_id", "fournisseur_id"] as const)("refuse %s contradictoire sans écriture", async (field) => {
    await expect(resolveNcControlContext(db, { control_id: control, description: "Écart", [field]: other })).rejects.toMatchObject({ code: "NC_CONTROL_CONTEXT_MISMATCH", status: 400 });
    expect((await db.query("SELECT lot_id::text FROM public.quality_control")).rows).toEqual([{ lot_id: lot }]);
  });
  it("refuse un contrôle supprimé, avec erreur métier", async () => {
    await expect(resolveNcControlContext(db, { control_id: other, description: "Écart" })).rejects.toMatchObject({ code: "INVALID_CONTROL", status: 400 });
  });
  it("reprend la source LOT explicite lorsque la colonne historique lot_id est vide", async () => {
    await db.query("UPDATE public.quality_control SET lot_id=NULL");
    expect((await resolveNcControlContext(db, { control_id: control, description: "Écart" })).lot_id).toBe(lot);
  });
  it("refuse un lot source incohérent ou invalide", async () => {
    await db.query("UPDATE public.quality_control SET source_id=$1", [other]);
    await expect(resolveNcControlContext(db, { control_id: control, description: "Écart" })).rejects.toMatchObject({ code: "NC_CONTROL_CONTEXT_MISMATCH" });
    await db.query("UPDATE public.quality_control SET source_id='incorrect'");
    await expect(resolveNcControlContext(db, { control_id: control, description: "Écart" })).rejects.toMatchObject({ code: "NC_CONTROL_CONTEXT_INVALID", status: 400 });
  });
  it("conserve le parcours historique OF et les liens facultatifs réellement inconnus", async () => {
    await db.query("UPDATE public.quality_control SET lot_id=NULL,source_type=NULL,source_id=NULL,reception_ligne_id=NULL,fournisseur_id=NULL,of_id=95,affaire_id=123,operation_id=$1,piece_technique_id=$2", [receipt, other]);
    const result = await resolveNcControlContext(db, { control_id: control, description: "Écart", lot_id: lot });
    expect(result).toMatchObject({ of_id: 95, affaire_id: 123, of_operation_id: receipt, piece_technique_id: other, lot_id: lot, reception_ligne_id: null });
    await expect(resolveNcControlContext(db, { control_id: control, description: "Écart", of_id: 96 })).rejects.toMatchObject({ code: "NC_CONTROL_CONTEXT_MISMATCH" });
  });
  it("la NC sans contrôle conserve son contexte direct sans requête", async () => {
    const body = { lot_id: lot, description: "Constat direct" };
    expect(await resolveNcControlContext(db, body)).toBe(body);
  });
});
