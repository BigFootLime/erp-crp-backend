import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import db from "../config/database";
import { errorHandler } from "../middlewares/errorHandler";
import { pieceAssemblyUsage } from "../module/pieces-techniques/controllers/assembly-usage.controller";
import {
  repoAddBomLine, repoGetFabricationTree, repoReorderBom, repoUpdateBomLine, type AuditContext,
} from "../module/pieces-techniques/repository/pieces-techniques.repository";
import { repoPreparePieceEdit } from "../module/pieces-techniques/repository/versions.repository";
import { createPieceTechniqueWithReplaySVC } from "../module/pieces-techniques/services/pieces-techniques.service";
import { addBomLineSchema, createPieceTechniqueSchema, createSubPieceTechniqueSchema } from "../module/pieces-techniques/validators/pieces-techniques.validators";
import { getAssemblyPlanning, saveAssemblyPlanning } from "../module/planning/controllers/assembly-planning.controller";
import { ofAssemblyUsage } from "../module/production/controllers/of-assembly-usage.controller";

const fixturePort = process.env.CERP_SUBRANK_FIXTURE_PORT;
const enabled = process.env.CERP_E2E_ISOLATED === "1" && /^\d+$/.test(fixturePort ?? "") &&
  process.env.DATABASE_URL === "postgresql://postgres@127.0.0.1:" + fixturePort + "/cerp_test";
const app = express();
app.use(express.json());
app.get("/pieces/:id/assemblages", pieceAssemblyUsage);
app.get("/ofs/:id/assemblages", ofAssemblyUsage);
app.get("/assembly", getAssemblyPlanning);
app.put("/assembly", saveAssemblyPlanning);
app.use(errorHandler);

describe.skipIf(!enabled)("Sous-rangs et assemblage — PostgreSQL jetable", () => {
  let audit: AuditContext;
  const design = "Assemblage synthétique " + randomUUID().slice(0, 8);
  const create = (values: Record<string, unknown>, key = randomUUID()) =>
    createPieceTechniqueWithReplaySVC((values.sub_piece ? createSubPieceTechniqueSchema : createPieceTechniqueSchema).parse({
      body: { name_piece: design, designation: design, ...values },
    }).body, audit, key);

  beforeAll(async () => {
    const identity = await db.query("SELECT current_database() AS db,current_user AS role, current_setting('cluster_name') AS cluster");
    expect(identity.rows[0]).toEqual({ db: "cerp_test", role: "postgres", cluster: "cerp-sous-rangs-fixture" });
    const actor = await db.query("SELECT id FROM public.users ORDER BY id LIMIT 1");
    audit = { user_id: actor.rows[0].id, ip: null, user_agent: null, device_type: null,
      os: null, browser: null, path: null, page_key: null, client_session_id: null };
  });

  afterAll(async () => { await db.end(); });

  it("crée les sous-pièces CLIENTS et CRP avec le bon indice, et conserve un seul lien au rejeu", async () => {
    for (const scope of ["CLIENTS", "CRP"]) {
      const parent = (await create({ commercial_scope: scope, indice_externe: "B", ensemble: true,
        ...(scope === "CLIENTS" && { code_client: "CLI-901", plan_reference: "PLAN " + randomUUID().slice(0, 6) }),
      })).piece;
      const tree = await repoGetFabricationTree(parent.id);
      const parentVersion = tree?.root.technical_version_id;
      expect(parentVersion).toBeTruthy();
      const payload = { sub_piece: { parent_piece_id: parent.id, parent_version_id: parentVersion,
        same_reference: true, rang: 31, repere: 7, quantite: 2.5 } };
      const key = randomUUID();
      const { piece: child } = await create(payload, key);
      expect(child).toMatchObject({ code_piece: parent.code_piece + " REP 07", plan_reference: parent.plan_reference + " REP 07" });
      const childTree = await repoGetFabricationTree(child.id);
      expect(childTree?.root.indice).toBe("B");
      expect((await create(payload, key)).replayed).toBe(true);
      const children = (await repoGetFabricationTree(parent.id))?.root.children;
      expect(children).toHaveLength(1);
      expect(children?.[0]).toMatchObject({ ordre_affichage: 31, repere: "7", quantite_par_parent: 2.5 });
      const where = await request(app).get("/pieces/" + child.id + "/assemblages").expect(200);
      expect(where.body.items).toMatchObject([{ piece_id: parent.id, rang: 31, repere: "7", quantity: 2.5 }]);
    }
  });

  it("enregistre un repère NULL pour une création indépendante ou une association sans repère", async () => {
    const mother = (await create({ commercial_scope: "CRP", indice_externe: "A", ensemble: true })).piece;
    const link = { parent_piece_id: mother.id, rang: 14, quantite: 2 };
    const { piece: child } = await create({
      commercial_scope: "CRP", indice_externe: "B", sub_piece: { ...link, same_reference: false },
    });
    await repoAddBomLine(mother.id, { child_piece_id: child.id, rang: 30, quantite: 1 });
    const tree = await repoGetFabricationTree(mother.id);
    expect(tree?.root.children.map(({ ordre_affichage, repere }) => [ordre_affichage, repere])).toEqual([[14, null], [30, null]]);
    expect(createSubPieceTechniqueSchema.safeParse({
      body: { name_piece: design, designation: design, sub_piece: { ...link, same_reference: true } },
    }).success).toBe(false);
  });

  it("refuse le rang concurrent sans créer une pièce orpheline et interdit les déplacements", async () => {
    const mother = (await create({ commercial_scope: "CRP", indice_externe: "A", ensemble: true })).piece;
    const attempts = await Promise.allSettled([14, 77].map((repere) => create({
      designation: "Sous-rang synthétique " + repere,
      commercial_scope: "CRP", indice_externe: "D",
      sub_piece: { parent_piece_id: mother.id, same_reference: false, rang: 79, repere, quantite: 1 },
    })));
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.find((attempt) => attempt.status === "rejected")).toMatchObject({ reason: { code: "BOM_RANK_TAKEN" } });
    const count = await db.query("SELECT count(*)::int AS n FROM public.pieces_techniques WHERE designation = ANY($1) AND name_piece=$2", [
      ["Sous-rang synthétique 14", "Sous-rang synthétique 77"], design,
    ]);
    expect(count.rows[0].n).toBe(1);
    const existing = (await repoGetFabricationTree(mother.id))!.root.children[0];
    expect(existing.indice).toBe("D");
    expect(existing.ordre_affichage).toBe(79);
    await expect(repoUpdateBomLine(mother.id, existing.bom_line_id!, { rang: 10 })).rejects.toMatchObject({ code: "BOM_REORDER_DISABLED" });
    await expect(repoReorderBom(mother.id, [existing.bom_line_id!])).rejects.toMatchObject({ code: "BOM_REORDER_DISABLED" });
    for (const rang of [undefined, 0, 100, 1.5]) {
      expect(addBomLineSchema.safeParse({ body: { child_piece_id: existing.piece_technique_id, rang } }).success).toBe(false);
    }
    await repoAddBomLine(mother.id, { child_piece_id: existing.piece_technique_id, rang: 5, quantite: 1 });
    await db.query(`UPDATE public.piece_technique_versions SET statut='APPLICABLE', is_current=true,
      date_application=CURRENT_DATE, date_validation=now() WHERE piece_technique_id=$1`, [mother.id]);
    const { version } = await repoPreparePieceEdit(mother.id, audit);
    expect(version).toBeTruthy();
    const revised = await repoGetFabricationTree(mother.id, 8, version!.id);
    expect(revised?.root.children.map((child) => child.ordre_affichage)).toEqual([5, 79]);
  });

  it("retrouve les OF consommateurs ouverts sur leurs besoins enregistrés et isole les heures par semaine", async () => {
    const parent = (await create({ commercial_scope: "CRP", indice_externe: "A", ensemble: true })).piece;
    const child = (await create({ commercial_scope: "CRP", indice_externe: "A" })).piece;
    const parentVersion = (await repoGetFabricationTree(parent.id))!.root.technical_version_id;
    const order = async (pieceId: string, numero: string, status = "BROUILLON") =>
      (await db.query(`INSERT INTO public.ordres_fabrication(numero,piece_technique_id,statut,quantite_lancee)
        VALUES($1,$2,$3,1) RETURNING id::text`, [numero + "-" + design.slice(-8), pieceId, status])).rows[0].id as string;
    const consumer = await order(parent.id, "OF-FIXTURE-MONTAGE");
    const cancelled = await order(parent.id, "OF-FIXTURE-ANNULE", "ANNULE");
    const source = await order(child.id, "OF-FIXTURE-COMPOSANT");
    for (const id of [consumer, cancelled]) {
      await db.query(`INSERT INTO public.of_component_requirements
        (consuming_of_id,parent_piece_technique_id,parent_piece_technique_version_id,
         component_kind,component_piece_technique_id,structure_path,quantity_per_parent,required_qty,action)
        VALUES ($1,$2,$3,'FABRICATED',$4,'component',3,3,'WAIT_TECHNICAL')`, [id, parent.id, parentVersion, child.id]);
    }
    const used = await request(app).get("/ofs/" + source + "/assemblages").expect(200);
    expect(used.body.items).toHaveLength(1);
    expect(used.body.items).toMatchObject([{ id: consumer, quantity: 3 }]);

    const week = "2026-11-23";
    const start = "2026-11-22T22:30:00Z";
    const end = "2026-11-23T00:30:00Z";
    const revision = (await db.query(
      "INSERT INTO public.of_revisions(of_id,revision_rank,revision_code,snapshot,snapshot_sha256,statut) VALUES($1,0,'R00','{}',repeat('0',64),'ACTIVE') RETURNING id",
      [consumer],
    )).rows[0].id;
    for (const [phase, type] of [[10, "ASSEMBLAGE"], [20, "FRAISAGE"], [30,"MONTAGE"]] as const) {
      const center = (await db.query(
        "INSERT INTO public.centres_frais (code,name,designation,type_cf) VALUES($1,$2,$2,$2) RETURNING id",
        ["CF-FIXTURE-" + type + "-" + design.slice(-8), type],
      )).rows[0].id;
      const operation = (await db.query(`INSERT INTO public.of_operations(of_id,phase,designation,cf_id,revision_id)
        VALUES($1,$2,$3,$4,$5) RETURNING id`, [consumer, phase, type, center,revision])).rows[0].id;
      if (phase === 30) continue;
      const poste = (await db.query("INSERT INTO public.postes(code,label) VALUES($1,'Poste synthétique') RETURNING id", ["POSTE-" + phase + "-" + design.slice(-8)])).rows[0].id;
      await db.query(`INSERT INTO public.planning_events(id,of_operation_id,poste_id,title,start_ts,end_ts,kind)
        VALUES($1,$2,$3,$4,$5,$6,'OF_OPERATION')`, [randomUUID(), operation, poste, type, start, end]);
    }
    const url = "/assembly?week=" + week;
    const first = await request(app).get(url).expect(200);
    expect(first.body.operations.filter((op: { of_id: string }) => op.of_id === consumer)).toMatchObject([{ phase: 10, minutes: 90 }]);
    expect(first.body.unplanned.filter((op: { of_id: string }) => op.of_id === consumer)).toMatchObject([{ phase: 30, minutes: null }]);
    expect(first.body.team.map((member: { label: string }) => member.label)).toEqual(["Florence Berliet", "Nizier", "Clément"]);
    const presence = [{ userId: audit.user_id, minutes: [450, null, null, null, null, 0, 0] }];
    const payload = { week, team: [audit.user_id, null, null], presence, teamVersion: first.body.teamVersion, weekVersion: first.body.weekVersion };
    await request(app).put("/assembly").send(payload).expect(204);
    expect((await request(app).get(url).expect(200)).body.presence).toEqual(presence);
    expect((await request(app).get("/assembly?week=2026-11-30").expect(200)).body.presence).toEqual([]);
    await request(app).put("/assembly").send(payload).expect(409);
  });
});
