import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import portalDemandRoutes from "../../demand-pilot/routes/demand-pilot-portal.routes";
import { signPortalSession } from "../../client-portal/domain/client-portal-security";
import { errorHandler } from "../../../middlewares/errorHandler";
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
import { openContractOrder } from "../../commande-client/repository/open-orders.repository";
import { repoCreateCommande } from "../../commande-client/repository/commande-client.repository";
import {
  recordCarco,
  getCarco,
  bindReviewContract,
  qualifyOpenSchedule,
  listPortalCarcoDeposits,
  submitCarco,
} from "../../demand-pilot/services/carco-review.service";

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
    target: new Date(Date.UTC(year, month - 1, 0)).toISOString().slice(0, 10),
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
        [
          contractId,
          clientId,
          prefix,
          window.validFrom,
          window.validUntil,
          actor,
        ],
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
    afterEach(() => vi.unstubAllEnvs());

    it("prepares a canonical contract plan, rejects a stale plan, generates one unbound OF and replays without duplicates", async () => {
      await expect(
        openContractOrder(clientId, contractId, 999, actor),
      ).rejects.toMatchObject({ code: "OPEN_CONTRACT_STALE" });
      const orders = await Promise.all([
        openContractOrder(clientId, contractId, 1, actor),
        openContractOrder(clientId, contractId, 1, actor),
      ]);
      expect(orders.filter((o) => o.created)).toHaveLength(1);
      expect(orders[0].order.number).toBe(orders[1].order.number);
      expect(
        (
          await pool.query(
            "SELECT id FROM public.ordres_fabrication WHERE article_id=$1",
            [articleId],
          )
        ).rowCount,
      ).toBe(0);
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
      const forecastLine = (
        await pool.query(
          "SELECT id,version FROM public.client_contract_forecasts WHERE contract_line_id=$1",
          [contractLineId],
        )
      ).rows[0];
      const article = (
        await pool.query(
          "SELECT piece_technique_id,configured_piece_technique_version_id AS version FROM public.articles a JOIN public.client_contract_lines l ON l.article_id=a.id WHERE l.id=$1",
          [contractLineId],
        )
      ).rows[0];
      const firm = {
        client_id: clientId,
        order_type: "FERME" as const,
        code_client: "CALL-" + prefix,
        date_commande: needDate,
        client_contract_call: {
          contract_id: contractId,
          expected_version: 1,
          idempotency_key: randomUUID(),
        },
        lignes: [
          {
            article_id: articleId,
            piece_technique_id: article.piece_technique_id,
            piece_technique_version_id: article.version,
            client_contract_line_id: contractLineId,
            client_forecast_allocations: [
              {
                forecast_id: forecastLine.id,
                expected_version: forecastLine.version,
                quantity,
              },
            ],
            designation: articleCode,
            unite: "u",
            quantite: quantity,
            delai_client: needDate,
            prix_unitaire_ht: 5,
            taux_tva: 20,
          },
        ],
      };
      const call = await repoCreateCommande(firm, [], actor);
      expect(await repoCreateCommande(firm, [], actor)).toEqual(call);
      const link = await pool.query(
        "SELECT 1 FROM public.client_contract_calls WHERE contract_id=$1 AND commande_id=$2",
        [contractId, call.id],
      );
      expect(link.rowCount).toBe(1);
      expect(
        (
          await pool.query(
            "SELECT id FROM public.ordres_fabrication WHERE article_id=$1",
            [articleId],
          )
        ).rowCount,
      ).toBe(1);
    }, 30000);
    it("deposits a portal workbook for ADV review, with client/site checks and explicit contract binding", async () => {
      const scope = { clientId, site: "SITE-" + randomUUID() },
        account = randomUUID(),
        email = account + "@example.invalid";
      await pool.query(
        `INSERT INTO public.client_portal_accounts(id,client_id,email,email_normalized,display_name,password_hash,status,activated_at,created_by,updated_by)
        VALUES($1,$2,$3,$3,'Pilote',repeat('x',60),'ACTIVE',now(),$4,$4)`,
        [account, clientId, email, actor],
      );
      const text =
        "NUM_CDE;NUM_LIGNE_CDE;ARTICLE;TYPE_CDE;FERMETE;DATE_BESOIN;QTE_SOLDE;QTE_LIV;ID_ECHEANCE;UNITE\n" +
        "ORDER;1;" +
        externalCode +
        ";Cde ouverte;;" +
        needDate +
        ";12;2;;PCE";
      const buffer = Buffer.from(text);
      const file = {
        originalname: "carco.csv",
        mimetype: "text/csv",
        buffer,
        size: buffer.length,
      } as Express.Multer.File;
      const who = { portalAccountId: account },
        at = "2026-11-02T08:00:00Z";
      await expect(
        recordCarco(scope, "W1", at, false, file, who),
      ).rejects.toMatchObject({ code: "DEMAND_PILOT_PORTAL_SITE" });
      await pool.query(
        "INSERT INTO public.client_portal_demand_sites(portal_account_id,external_site,created_by_user_id) VALUES($1,$2,$3)",
        [account, scope.site, actor],
      );
      vi.stubEnv("CLIENT_PORTAL_JWT_SECRET", randomUUID() + randomUUID());
      const app = express()
        .use("/demand", portalDemandRoutes)
        .use(errorHandler);
      const token = signPortalSession({
        clientId,
        accountId: account,
        sessionEpoch: 0,
      });
      const upload = (site: string) =>
        request(app)
          .post("/demand/carco")
          .set("Authorization", "Bearer " + token)
          .field("external_site", site)
          .field("source_version", "W1")
          .field("source_as_of", at)
          .attach("file", buffer, {
            filename: "carco.csv",
            contentType: "text/csv",
          });
      await request(app).get("/demand/carco").expect(401);
      await upload("UNAUTHORIZED-SITE").expect(403);
      const response = await upload(scope.site).expect(200);
      const id = response.body.id as string;
      expect(Object.keys(response.body).sort()).toEqual([
        "external_site",
        "id",
        "source_version",
      ]);
      const history = await request(app)
        .get("/demand/carco")
        .set("Authorization", "Bearer " + token)
        .expect(200);
      expect(history.body.sites).toEqual([scope.site]);
      expect(await recordCarco(scope, "W1", at, false, file, who)).toBe(id);
      expect(await listPortalCarcoDeposits(clientId, account)).toHaveLength(1);
      expect(
        await listPortalCarcoDeposits(clientId, randomUUID()),
      ).toHaveLength(0);
      expect((await getCarco(scope, id))?.ready).toHaveLength(0);
      await bindReviewContract(scope, id, contractId, actor);
      expect((await getCarco(scope, id))?.ready).toHaveLength(0);
      await qualifyOpenSchedule(scope, id, 2, "FORECAST", "S-1", actor);
      await expect(
        qualifyOpenSchedule(scope, id, 2, "FIRM", "S-1", actor),
      ).rejects.toMatchObject({ code: "CARCO_KIND_CONFLICT" });
      const qualified = (await getCarco(scope, id))!;
      expect(qualified.ready).toHaveLength(1);
      expect(qualified.lines[0].resolved?.contract_line_id).toBe(
        contractLineId,
      );
      const imported = await submitCarco(
        scope,
        id,
        actor,
        randomUUID(),
        qualified.qualification_hash,
      );
      expect(imported.created).toBe(1);
      const split = Buffer.from(text + "\n" + text.split("\n")[1]);
      const next = await recordCarco(
        scope,
        "W2",
        "2026-11-09T08:00:00Z",
        false,
        { ...file, buffer: split, size: split.length },
        who,
      );
      await expect(
        qualifyOpenSchedule(scope, next, 2, "FORECAST", "S-1", actor),
      ).rejects.toMatchObject({ code: "CARCO_BIND_AMBIGUOUS" });
      await pool.query(
        "DELETE FROM public.client_portal_demand_sites WHERE portal_account_id=$1",
        [account],
      );
      await expect(
        recordCarco(scope, "W1", at, false, file, who),
      ).rejects.toMatchObject({ code: "DEMAND_PILOT_PORTAL_SITE" });
      expect(await listPortalCarcoDeposits(clientId, account)).toHaveLength(0);
    });
  },
);
