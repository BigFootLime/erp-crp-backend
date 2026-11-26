import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import db from "../../../config/database";
import { addAchatSVC, getPieceTechniqueSVC, updateAchatSVC } from "../services/pieces-techniques.service";
import { addAchatSchema, updateAchatSchema } from "../validators/pieces-techniques.validators";

import { TECHNICAL_PURCHASE_SNAPSHOT_SQL } from "../../production/repository/production-preparation.repository";
import { sourceHash } from "../../production/domain/preparation-rules";
import { repoGammeProfitability } from "../../gammes/repository/gamme-profitability.repository";
import { COPY_VERSION_PURCHASES_SQL } from "./version-purchases.sql";

const fixtureURL = process.env.DATABASE_URL;
const isolated = process.env.CERP_TREATMENT_PRICING_PG_TEST === "1"
  && fixtureURL !== undefined && new URL(fixtureURL).hostname === "127.0.0.1"
  && new URL(fixtureURL).pathname === "/cerp_test";

describe.skipIf(!isolated)("special process purchase pricing on isolated PostgreSQL", () => {
  const piece = randomUUID();
  const version = randomUUID(), nextVersion = randomUUID(), gamme = randomUUID();
  const purchase = (amounts: Record<string, unknown>) => addAchatSchema.parse({
    body: { type_achat: "TRAITEMENT", designation: "Traitement synthétique", quantite: 2, ...amounts },
  }).body;
  beforeAll(async () => {
    const { rows } = await db.query("SELECT current_database() AS name, inet_server_port() AS port");
    expect(rows[0]).toMatchObject({ name: "cerp_test" });
    await db.query(`INSERT INTO public.pieces_techniques
      (id,root_piece_technique_id,version_number,name_piece,code_piece,designation)
      VALUES ($1,$1,1,'Pièce fixture',$2,'Pièce fixture')`, [piece, `PT-${piece}`]);
  });
  afterAll(async () => {
    await db.query("DELETE FROM public.pieces_techniques_achats WHERE piece_technique_id=$1", [piece]);
    await db.query("DELETE FROM public.gammes WHERE id=$1", [gamme]);
    await db.query("DELETE FROM public.piece_technique_versions WHERE id=ANY($1::uuid[])", [[version,nextVersion]]);
    await db.query("DELETE FROM public.pieces_techniques WHERE id=$1", [piece]);
    await db.end();
  });
  it("persists fixed, minimum, unpriced and explicitly zero estimates without a supplier", async () => {
    const flat = await addAchatSVC(piece, purchase({ forfait_ht: 42.25 }));
    const min = await addAchatSVC(piece, purchase({ prix: 2, pu_achat: 2, minimum_facturation_ht: 10 }));
    const blank = await addAchatSVC(piece, purchase({}));
    const zero = await addAchatSVC(piece, purchase({ prix: 0, pu_achat: 0 }));
    expect(flat).toMatchObject({ fournisseur_id: null, forfait_ht: 42.25, prix: null, total_achat_ht: 42.25, total_achat_ttc: 50.7 });
    expect(min).toMatchObject({ fournisseur_id: null, minimum_facturation_ht: 10, total_achat_ht: 10 });
    expect(blank?.prix).toBeNull();
    expect(zero?.prix).toBe(0);

    const update = updateAchatSchema.parse({ body: { quantite: 8 } }).body;
    expect(await updateAchatSVC(piece, min!.id!, update)).toMatchObject({ prix: 2, minimum_facturation_ht: 10, total_achat_ht: 16 });
    expect(await updateAchatSVC(piece, flat!.id!, { designation: "Finition éditée" })).toMatchObject({ forfait_ht: 42.25, total_achat_ht: 42.25 });
    expect(await updateAchatSVC(piece, flat!.id!, { forfait_ht: null, prix: 1.25, pu_achat: 1.25 })).toMatchObject({ forfait_ht: null, total_achat_ht: 2.5 });
    expect((await getPieceTechniqueSVC(piece, new Set(['achats'])))?.achats).toEqual(expect.arrayContaining([expect.objectContaining({ id: min!.id, minimum_facturation_ht: 10, total_achat_ht: 16 })]));
  });
  it("preserves the stored estimate on an invalid partial price update", async () => {
    const flat = await addAchatSVC(piece, purchase({ forfait_ht: 35 }));
    await expect(updateAchatSVC(piece, flat!.id!, { prix: 2 })).rejects.toMatchObject({ code: "PURCHASE_PRICING_INVALID" });
    expect((await getPieceTechniqueSVC(piece, new Set(['achats'])))?.achats).toEqual(expect.arrayContaining([expect.objectContaining({ id: flat!.id, prix: null, forfait_ht: 35 })]));
    expect(() => purchase({ minimum_facturation_ht: 3 })).toThrow();
    expect(() => purchase({ type_achat: "MATIERE", forfait_ht: 5 })).toThrow();
  });
  it("keeps old dossier hashes and copies new prices for a revised definition", async () => {
    await db.query(`INSERT INTO public.piece_technique_versions(id,piece_technique_id,plan_reference,indice,statut)
      VALUES($1,$2,$3,'A','BROUILLON'),($4,$2,$3,'B','BROUILLON')`, [version, piece, `PLAN-${piece}`, nextVersion]);
    const plain = await addAchatSVC(piece, purchase({ piece_technique_version_id:version, prix:1 }));
    const min = await addAchatSVC(piece, purchase({ piece_technique_version_id:version, quantite:1, prix:2, pu_achat:5, minimum_facturation_ht:12 }));
    const evidence = await db.query(`SELECT p.id, ${TECHNICAL_PURCHASE_SNAPSHOT_SQL} AS candidate,
      to_jsonb(p) - 'forfait_ht' - 'minimum_facturation_ht' AS legacy
      FROM public.pieces_techniques_achats p WHERE p.id=ANY($1::uuid[])`, [[plain!.id,min!.id]]);
    const old = evidence.rows.find(row => row.id===plain!.id);
    const updated = evidence.rows.find(row => row.id===min!.id);
    expect(sourceHash(old.candidate)).toBe(sourceHash(old.legacy));
    expect(updated.candidate).toMatchObject({ minimum_facturation_ht:12 });
    const copied = await db.query(COPY_VERSION_PURCHASES_SQL,[piece,nextVersion,version,"{}",null]);
    expect(copied.rowCount).toBe(2);
    const copiedMinimum = await db.query("SELECT minimum_facturation_ht::float8 AS minimum FROM public.pieces_techniques_achats WHERE piece_technique_version_id=$1 AND minimum_facturation_ht IS NOT NULL",[nextVersion]);
    expect(copiedMinimum.rows).toEqual([{minimum:12}]);
    await db.query(`INSERT INTO public.gammes(id,piece_technique_version_id,code,designation,statut,is_current)
      VALUES ($1,$2,$3,'Gamme synthétique','BROUILLON',true)`,[gamme,version,`G-${piece}`]);
    const result = await repoGammeProfitability(gamme,5);
    expect(result.purchases.find(row => row.purchase_id===min!.id)?.cost).toBe(12);
  });

});
