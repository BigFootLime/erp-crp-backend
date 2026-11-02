import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pool from "../../../config/database";
import {
  createPilotFixtureArticle,
  createPilotFixtureClient,
} from "../../../__tests__/fixtures/demand-pilot.fixture";
import { saveArticleMapping } from "../../demand-pilot/repository/demand-mapping.repository";
import { executeClientForecastCommand } from "./client-contract-forecast.service";
import { readClientContractCoverageTx } from "./client-contract-coverage.service";
import { prepareClientReplenishment } from "./client-contract-replenishment.service";
import { generateClientContractReplenishment } from "./client-contract-replenishment-launch.service";

const database = new URL(
  process.env.DATABASE_URL ?? "postgres://localhost/off",
);
const enabled =
  process.env.CERP_E2E_ISOLATED === "1" &&
  process.env.CERP_VISION_CONTRACT_MAKE_POSTGRES_TEST === "1" &&
  ["127.0.0.1", "localhost", "[::1]"].includes(database.hostname) &&
  database.pathname === "/cerp_test";

const prefix = `VISION-CONTRACT-${randomUUID()}`;
let clientId: string;
const articleCode = prefix;
const externalCode =
  process.env.VISION_CONTRACT_TEST_ARTICLE_CODE ?? "VISION-FORECAST-PILOT";
const quantity = Number(process.env.VISION_CONTRACT_TEST_QUANTITY ?? "1");
function contractWindow(needDate: string) {
  const year = Number(needDate.slice(0, 4));
  const month = Number(needDate.slice(5, 7));
  return {
    validFrom: `${year - 1}-01-01`,
    validUntil: `${year + 1}-12-31`,
    target: new Date(Date.UTC(year, month - 1, 0))
      .toISOString()
      .slice(0, 10),
  };
}
const audit = {
  user_id: 0,
  ip: "127.0.0.1",
  user_agent: "isolated-contract-make-test",
  device_type: null,
  os: null,
  browser: null,
  path: "/api/v1/production/clients/fixture/contracts/fixture/replenishment/commands",
  page_key: "production.replenishment",
  client_session_id: null,
};

describe.skipIf(!enabled)(
  "Vision-style open contract MAKE, isolated PostgreSQL",
  () => {
    let actor = 0;
    const articleId = randomUUID();
    let contractId = "";
    let contractLineId = "";
    let needDate = "";
    let forecastMonth = "";
    let expectedTarget = "";

    beforeAll(async () => {
      actor = Number(
        (
          await pool.query(
            "SELECT id FROM public.users WHERE is_superadmin LIMIT 1",
          )
        ).rows[0].id,
      );
      audit.user_id = actor;
      needDate = (
        await pool.query<{ due: string }>(
          "SELECT (CURRENT_DATE + 28)::text AS due",
        )
      ).rows[0].due;
      forecastMonth = needDate.slice(0, 7);
      const window = contractWindow(needDate);
      expectedTarget = window.target;
      clientId = await createPilotFixtureClient(
        pool,
        "R",
        "Vision contract MAKE isolated",
      );
      const tx = await pool.connect();
      let version = "";
      try {
        await tx.query("BEGIN");
        ({ version } = await createPilotFixtureArticle(
          tx,
          clientId,
          actor,
          articleId,
          articleCode,
        ));
        await saveArticleMapping(
          tx,
          {
            client_id: clientId,
            external_code: externalCode,
            external_unit: "PCE",
            article_id: articleId,
            units_per_external: 1,
          },
          actor,
        );
        await tx.query("COMMIT");
      } catch (error) {
        await tx.query("ROLLBACK");
        throw error;
      } finally {
        tx.release();
      }
      const unitId = (
        await pool.query("SELECT id FROM public.units WHERE code='u'")
      ).rows[0].id;
      contractId = randomUUID();
      contractLineId = randomUUID();
      await pool.query(
        `INSERT INTO public.client_contracts(id,client_id,reference,title,valid_from,valid_until,status,created_by,updated_by)
       VALUES($1,$2,$3,'Vision-style open contract MAKE isolated',$4::date,$5::date,'ACTIVE',$6,$6)`,
        [contractId, clientId, prefix, window.validFrom, window.validUntil, actor],
      );
      await pool.query(
        `INSERT INTO public.client_contract_lines(id,contract_id,article_id,root_article_id,replenishment_qty,unit_id,
        configured_code,configured_designation,configured_indice,configured_piece_technique_version_id)
       VALUES($1,$2,$3,$3,1,$4,$5,'Vision-style manufactured part','A',$6)`,
        [contractLineId, contractId, articleId, unitId, articleCode, version],
      );
    });

    afterAll(async () => {
      await pool.end();
    });

    it("prepares a canonical contract plan, rejects a stale plan, generates one unbound OF and replays without duplicates", async () => {
      expect(
        Number.isFinite(quantity) && quantity > 0 && quantity <= 1000,
      ).toBe(true);
      const forecast = await executeClientForecastCommand(
        clientId,
        contractId,
        {
          action: "SAVE",
          expected_contract_version: 1,
          expected_version: null,
          contract_line_id: contractLineId,
          month: forecastMonth,
          quantity,
          delivery_due: needDate,
          estimate_date: needDate,
          reason: "Isolated Vision-style demand",
        },
        randomUUID(),
        audit,
      );
      expect(forecast.replayed).toBe(false);

      const tx = await pool.connect();
      let coverage;
      try {
        await tx.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        coverage = await readClientContractCoverageTx(
          tx,
          clientId,
          contractId,
          { start_month: forecastMonth, months: 2 },
        );
        await tx.query("COMMIT");
      } finally {
        await tx.query("ROLLBACK");
        tx.release();
      }
      const prepared = await prepareClientReplenishment(
        clientId,
        contractId,
        {
          action: "PREPARE",
          expected_contract_version: coverage.report.contract_version,
          expected_plan_id: null,
          expected_snapshot_hash: coverage.report.snapshot_hash,
          start_month: forecastMonth,
          months: 2,
        },
        randomUUID(),
        audit,
      );
      expect(prepared.replayed).toBe(false);
      expect(prepared.result.plan.proposals).toHaveLength(1);
      const proposal = prepared.result.plan.proposals[0];
      expect(proposal.article.code).toBe(articleCode);
      expect(proposal.proposed_quantity).toBe(quantity.toFixed(3));
      expect(proposal.target_date).toBe(expectedTarget);

      await expect(
        generateClientContractReplenishment(
          clientId,
          contractId,
          {
            action: "GENERATE",
            plan_id: randomUUID(),
            proposal_ids: [proposal.id],
          },
          randomUUID(),
          audit,
          "Production",
        ),
      ).rejects.toMatchObject({
        status: 409,
        code: "CONTRACT_REPLENISHMENT_PLAN_CHANGED",
      });

      const key = randomUUID();
      const generated = await generateClientContractReplenishment(
        clientId,
        contractId,
        {
          action: "GENERATE",
          plan_id: prepared.result.plan.id,
          proposal_ids: [proposal.id],
        },
        key,
        audit,
        "Production",
      );
      expect(generated.replayed).toBe(false);
      expect(generated.result.roots).toHaveLength(1);
      expect(generated.result.roots[0]).toMatchObject({
        proposal_id: proposal.id,
        article_id: articleId,
        quantity: quantity.toFixed(3),
        target_date: proposal.target_date,
      });
      const rootId = generated.result.roots[0].root_of_id;
      expect(
        (
          await pool.query(
            "SELECT commande_id,commande_ligne_id,client_id,quantite_lancee::text FROM public.ordres_fabrication WHERE id=$1",
            [rootId],
          )
        ).rows[0],
      ).toMatchObject({
        commande_id: null,
        commande_ligne_id: null,
        client_id: clientId,
        quantite_lancee: quantity.toFixed(3),
      });
      const replay = await generateClientContractReplenishment(
        clientId,
        contractId,
        {
          action: "GENERATE",
          plan_id: prepared.result.plan.id,
          proposal_ids: [proposal.id],
        },
        key,
        audit,
        "Production",
      );
      expect(replay).toEqual({ result: generated.result, replayed: true });
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS count FROM public.client_contract_replenishment_roots WHERE proposal_id=$1",
            [proposal.id],
          )
        ).rows[0].count,
      ).toBe(1);
      expect(
        (
          await pool.query<{ delivery_due: string }>(
            "SELECT delivery_due::text FROM public.client_contract_forecasts WHERE contract_line_id=$1::uuid",
            [contractLineId],
          )
        ).rows[0].delivery_due,
      ).toBe(needDate);
    }, 30000);
  },
);
