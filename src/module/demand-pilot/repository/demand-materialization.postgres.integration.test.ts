import { createPilotFixtureArticle } from "../../../__tests__/fixtures/demand-pilot.fixture";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pool from "../../../config/database";
import { importDemand } from "./demand-ingest.repository";
import { decideDemand, getDemand } from "./demand-pilot.repository";
import { processDemandMaterialization } from "../services/demand-pilot-materialization.service";
import { prepareFirmDraft } from "../services/demand-pilot-firm-draft.service";

const url = new URL(
  process.env.DATABASE_URL ?? "postgres://localhost/no_database",
);
const enabled =
  process.env.CERP_E2E_ISOLATED === "1" &&
  process.env.CERP_DEMAND_MATERIALIZATION_POSTGRES_TEST === "1" &&
  ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
  url.pathname === "/cerp_test";
const prefix = `MAT-${randomUUID()}`;
const clientId = "MFP";
let actor = 0,
  articleId = randomUUID(),
  contractId = "",
  lineId = "";

const row = (schedule: string, needDate: string, sourceVersion = "W1") => ({
  external_site: `${prefix}-SITE`,
  external_order_key: "ORDER",
  external_line_key: schedule,
  external_schedule_key: "S1",
  source_version: sourceVersion,
  source_as_of:
    sourceVersion === "W1" ? "2027-01-01T00:00:00Z" : "2027-01-08T00:00:00Z",
  article_code: prefix,
  article_id: articleId,
  contract_reference: prefix,
  unit: "U",
  kind: "FORECAST" as const,
  quantity: 10,
  need_date: needDate,
  quantity_basis: "REMAINING" as const,
});

describe.skipIf(!enabled)(
  "demand materialization on isolated seeded PostgreSQL",
  () => {
    beforeAll(async () => {
      actor = Number(
        (
          await pool.query(
            "SELECT id FROM public.users WHERE is_superadmin LIMIT 1",
          )
        ).rows[0].id,
      );
      await pool.query(
        "INSERT INTO public.clients(client_id,client_code,company_name) VALUES($1::text,$1::text,'Forecast PG isolated') ON CONFLICT(client_id) DO NOTHING",
        [clientId],
      );
      const tx = await pool.connect();
      let version: string;
      try {
        await tx.query("BEGIN");
        ({ version } = await createPilotFixtureArticle(
          tx,
          clientId,
          actor,
          articleId,
          prefix,
        ));
        await tx.query("COMMIT");
      } catch (e) {
        await tx.query("ROLLBACK");
        throw e;
      } finally {
        tx.release();
      }
      const technical = {
        root_article_id: articleId,
        unit_id: (
          await pool.query("SELECT id FROM public.units WHERE code='u'")
        ).rows[0].id,
        version_id: version,
      };
      contractId = randomUUID();
      lineId = randomUUID();
      await pool.query(
        `INSERT INTO public.client_contracts(id,client_id,reference,title,status,created_by,updated_by)
      VALUES($1,$2,$3,'Materialization isolated test','ACTIVE',$4,$4)`,
        [contractId, clientId, prefix, actor],
      );
      await pool.query(
        `INSERT INTO public.client_contract_lines(id,contract_id,article_id,root_article_id,replenishment_qty,unit_id,configured_code,configured_designation,configured_indice,configured_piece_technique_version_id)
      VALUES($1,$2,$3,$4,1,$5,$6,'Materialization isolated test','A',$7)`,
        [
          lineId,
          contractId,
          articleId,
          technical.root_article_id,
          technical.unit_id,
          prefix,
          technical.version_id,
        ],
      );
    });
    afterAll(async () => {
      await pool.end();
    });
    it("aggregates accepted schedules, removes the old month on a move, and is replay-safe", async () => {
      const initial = await importDemand({
        clientId,
        rows: [row("A", "2027-02-08"), row("B", "2027-02-18")],
        actor: { userId: actor },
        idempotencyKey: randomUUID(),
      });
      expect(initial.created).toBe(2);
      const initialRows = (
        await pool.query(
          "SELECT id FROM demand_pilot_revisions WHERE import_id=$1 ORDER BY external_line_key",
          [initial.import_id],
        )
      ).rows;
      for (const item of initialRows) {
        const demand = await getDemand(clientId, item.id);
        await decideDemand({
          clientId,
          id: demand.id,
          expectedVersion: demand.revision_no,
          action: "ACCEPT",
          actor: { userId: actor },
          idempotencyKey: randomUUID(),
        });
        await processDemandMaterialization(demand.id);
      }
      for (let i = 0; i < 50; i++) {
        const states = (
          await pool.query(
            `SELECT j.status FROM public.demand_pilot_materialization_jobs j JOIN public.demand_pilot_revisions r ON r.id=j.revision_id WHERE r.client_id=$1`,
            [clientId],
          )
        ).rows;
        if (states.length === 2 && states.every((row) => row.status === "DONE"))
          break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      let forecasts = await pool.query(
        `SELECT month::text,quantity::text FROM public.client_contract_forecasts WHERE contract_line_id=$1 ORDER BY month`,
        [lineId],
      );
      expect(
        forecasts.rows,
        JSON.stringify(
          (
            await pool.query(
              "SELECT j.status,j.last_error FROM public.demand_pilot_materialization_jobs j JOIN public.demand_pilot_revisions r ON r.id=j.revision_id WHERE r.client_id=$1",
              [clientId],
            )
          ).rows,
        ),
      ).toEqual([{ month: "2027-02-01", quantity: "20.000" }]);

      const second = await importDemand({
        clientId,
        rows: [
          {
            ...row("A", "2027-03-08", "W2"),
            source_as_of: "2027-01-02T00:00:00Z",
          },
        ],
        actor: { userId: actor },
        idempotencyKey: randomUUID(),
      });
      const moved = await getDemand(
        clientId,
        (
          await pool.query(
            "SELECT id FROM demand_pilot_revisions WHERE import_id=$1",
            [second.import_id],
          )
        ).rows[0].id,
      );
      await decideDemand({
        clientId,
        id: moved.id,
        expectedVersion: moved.revision_no,
        action: "ACCEPT",
        actor: { userId: actor },
        idempotencyKey: randomUUID(),
      });
      await processDemandMaterialization(moved.id);
      for (let i = 0; i < 50; i++) {
        const state = (
          await pool.query(
            "SELECT status FROM public.demand_pilot_materialization_jobs WHERE revision_id=$1::uuid",
            [moved.id],
          )
        ).rows[0]?.status;
        if (state === "DONE") break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(await processDemandMaterialization(moved.id)).toEqual({
        skipped: true,
      });
      forecasts = await pool.query(
        `SELECT month::text,quantity::text FROM public.client_contract_forecasts WHERE contract_line_id=$1 ORDER BY month`,
        [lineId],
      );
      expect(forecasts.rows).toEqual([
        { month: "2027-02-01", quantity: "10.000" },
        { month: "2027-03-01", quantity: "10.000" },
      ]);
      const firm=await importDemand({clientId,rows:[{...row("A","2027-03-08","W3"),source_as_of:"2027-01-15T00:00:00Z",kind:"FIRM",quantity:4}],
        actor:{userId:actor},idempotencyKey:randomUUID()});
      const revision=(await pool.query("SELECT id FROM public.demand_pilot_revisions WHERE import_id=$1",[firm.import_id])).rows[0].id;
      await prepareFirmDraft({client_id:clientId,revision_ids:[revision],lines:[{
        revision_id:revision,designation:"Conversion partielle",prix_unitaire_ht:12,taux_tva:20,remise_ligne:0
      }]},actor,randomUUID());
      const residual=await pool.query(`SELECT cov.converted_quantity::float8 converted,cov.remaining_quantity::float8 remaining
        FROM public.v_client_contract_forecast_coverage cov JOIN public.client_contract_forecasts f ON f.id=cov.forecast_id
        WHERE f.contract_line_id=$1 AND f.month='2027-03-01'`,[lineId]);
      expect(residual.rows[0]).toEqual({converted:4,remaining:6});
    }, 30000);
  },
);
