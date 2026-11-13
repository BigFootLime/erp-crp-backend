import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { createPilotFixtureClient } from "../../../__tests__/fixtures/demand-pilot.fixture";
import { readTreatmentAssumptions } from "./industrial-analysis.repository";
import { readIndustrialInput } from "./industrial-input.repository";

const url = process.env.CERP_TREATMENT_PLAN_TEST_DATABASE_URL;
describe.skipIf(!url)("retours estimés de sous-traitance dans le planning", () => {
  it("montre le retour dans le scénario du client sans en faire une réception CBN", async () => {
    const target = new URL(url!);
    if (url !== process.env.DATABASE_URL || !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) || target.pathname !== "/cerp_test")
      throw new Error("Base CERP locale de recette requise.");
    const pool = new Pool({ connectionString: url });
    const tx = await pool.connect();
    try {
      await tx.query("BEGIN");
      const clientId = await createPilotFixtureClient(tx, "T", "Recette retour de traitement");
      const other = await createPilotFixtureClient(tx, "T", "Recette périmètre distinct");
      const suffix = randomUUID().slice(0, 8);
      const order = (await tx.query("INSERT INTO commande_client(numero,client_id) VALUES($1,$2) RETURNING id", ["EST-" + suffix, clientId])).rows[0];
      const supplier = (await tx.query("INSERT INTO fournisseurs(code,nom) VALUES($1,'Recette traitement') RETURNING id", ["T-" + suffix])).rows[0];
      const po = (await tx.query("INSERT INTO commande_fournisseur(code,statut,origine,fournisseur_id) VALUES($1,'ENVOYEE','MANUEL',$2) RETURNING id", ["T-" + suffix, supplier.id])).rows[0];
      const line = (await tx.query(`INSERT INTO commande_fournisseur_ligne(commande_id,designation,quantite,qty_annulee,commande_client_id,operation_libelle,date_besoin)
        VALUES($1,'Traitement test',5,1,$2,'Traitement test','2026-11-20') RETURNING id`, [po.id, order.id])).rows[0];
      const inputs = () => readIndustrialInput(tx, clientId, "2026-11-01", 1, 4);
      const before = await inputs();
      await tx.query(`INSERT INTO supplier_internal_treatment_estimates
        (supplier_id,order_id,line_id,estimated_return_date,reason,source_version,created_by)
        SELECT $1,$2,$3,'2026-11-24','Calendrier traitement','v1',id FROM users ORDER BY id LIMIT 1`, [supplier.id, po.id, line.id]);
      expect(await readTreatmentAssumptions(tx, clientId)).toMatchObject([{
        line_id: line.id, estimated_return_date: "2026-11-24", need_date: "2026-11-20",
        confirmed_date: null, remaining_quantity: 4,
      }]);
      expect(await readTreatmentAssumptions(tx, other)).toEqual([]);
      expect((await inputs()).supplies).toEqual(before.supplies);
      await tx.query("UPDATE commande_fournisseur SET statut='CLOTUREE' WHERE id=$1", [po.id]);
      expect(await readTreatmentAssumptions(tx, clientId)).toEqual([]);
    } finally {
      await tx.query("ROLLBACK");
      tx.release();
      await pool.end();
    }
  });
});
