import { randomUUID, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import express from "express";
import pool from "../../../config/database";
import router from "../routes/demand-pilot-portal.routes";
import { signPortalSession } from "../../client-portal/domain/client-portal-security";
import { createPilotFixtureArticle } from "../../../__tests__/fixtures/demand-pilot.fixture";
import { decideDemand } from "./demand-pilot.repository";
import { processAgreedCounterOffer } from "../services/demand-counter.worker";
import { industrialTx } from "../../planning/services/industrial-runs.service";
import { saveArticleMapping } from "./demand-mapping.repository";
const url = new URL(process.env.DATABASE_URL ?? "postgres://localhost/off");
const isolated =
  process.env.CERP_E2E_ISOLATED === "1" &&
  process.env.CERP_DEMAND_POSTGRES_TEST === "1" &&
  url.pathname === "/cerp_test" &&
  ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
const app = express()
  .use(express.json())
  .use("/api/v1/client-portal/demand", router);
app.use(((
  e: { status?: number; code?: string },
  _req: express.Request,
  res: express.Response,
  _next: express.NextFunction,
) => {
  res.status(e.status ?? 500).json({ code: e.code });
}) as express.ErrorRequestHandler);
const base = "/api/v1/client-portal/demand",
  client = "PQA",
  code = "QA-" + randomUUID(),
  account = randomUUID(),
  article = randomUUID(),
  site = code;
let token: string,
  actor: number,
  contract: string,
  oldSecret: string | undefined;
describe.skipIf(!isolated)(
  "Demand via authenticated customer routes on isolated PostgreSQL",
  () => {
    beforeAll(async () => {
      oldSecret = process.env.CLIENT_PORTAL_JWT_SECRET;
      process.env.CLIENT_PORTAL_JWT_SECRET = randomBytes(40).toString("hex");
      actor = (
        await pool.query(
          "SELECT id FROM public.users WHERE is_superadmin LIMIT 1",
        )
      ).rows[0].id;
      await industrialTx(async (tx) => {
        await tx.query(
          "INSERT INTO clients(client_id,client_code,company_name) VALUES($1::text,$1::text,'Test portail isolé') ON CONFLICT(client_id) DO NOTHING",
          [client],
        );
        const { version } = await createPilotFixtureArticle(
          tx,
          client,
          actor,
          article,
          code,
        );
        contract = randomUUID();
        await tx.query(
          "INSERT INTO client_contracts(id,client_id,reference,title,status,created_by,updated_by) VALUES($1,$2,$3,'Portail de recette','ACTIVE',$4,$4)",
          [contract, client, code, actor],
        );
        await tx.query(
          `INSERT INTO client_contract_lines(contract_id,article_id,root_article_id,unit_id,replenishment_qty,configured_code,configured_designation,configured_indice,configured_piece_technique_version_id)
    SELECT $1,$2,$2,id,1,$3,'Article de test','A',$4 FROM public.units WHERE code='u'`,
          [contract, article, code, version],
        );
        await tx.query(
          `INSERT INTO client_portal_accounts(id,client_id,email,email_normalized,display_name,password_hash,status,activated_at,created_by,updated_by)
     VALUES($1,$2,$3,$3,'Compte de test',$4,'ACTIVE',now(),$5,$5)`,
          [account, client, account + "@invalid.test", "x".repeat(60), actor],
        );
        await tx.query(
          "INSERT INTO client_portal_demand_sites(portal_account_id,external_site,created_by_user_id) VALUES($1,$2,$3)",
          [account, site, actor],
        );
        await saveArticleMapping(
          tx,
          {
            client_id: client,
            article_id: article,
            external_code: code + "-EXT",
            external_unit: "PCE",
            units_per_external: 1,
          },
          actor,
        );
      });
      token = signPortalSession({
        accountId: account,
        clientId: client,
        sessionEpoch: 0,
      });
    });
    afterAll(async () => {
      if (oldSecret === undefined) delete process.env.CLIENT_PORTAL_JWT_SECRET;
      else process.env.CLIENT_PORTAL_JWT_SECRET = oldSecret;
      await pool.end();
    });
    it("rejects cross-site/manual submissions; requires agreement to the exact dated counter-offer", async () => {
      const row = {
        external_site: site,
        external_order_key: "CDE",
        external_line_key: "10",
        external_schedule_key: "A",
        source_version: "r1",
        source_as_of: "2027-01-04T09:00:00Z",
        article_code: code + "-EXT",
        unit: "PCE",
        kind: "FORECAST",
        quantity: 7,
        quantity_basis: "REMAINING",
        need_date: "2027-02-05",
        contract_reference: code,
      };
      const post = (path: string, body: unknown, key = randomUUID()) =>
        request(app)
          .post(base + path)
          .set("Authorization", "Bearer " + token)
          .set("Idempotency-Key", key)
          .send(body as object);
      await request(app).get(base).expect(401);
      await post("/manual", {
        rows: [{ ...row, external_site: site + "-B" }],
      }).expect(403);
      const created = await post("/manual", { rows: [row] }).expect(201);
      const id = (
        await pool.query(
          "SELECT id FROM demand_pilot_revisions WHERE import_id=$1",
          [created.body.import_id],
        )
      ).rows[0].id;
      await decideDemand({
        clientId: client,
        id,
        expectedVersion: 1,
        action: "COUNTER",
        confirmedNeedDate: "2027-02-15",
        reason: "Fermeture atelier",
        actor: { userId: actor },
        idempotencyKey: randomUUID(),
      });
      const read = await request(app)
        .get(base + "/" + id)
        .set("Authorization", "Bearer " + token)
        .expect(200);
      expect(read.body.data.need_date).toBe("2027-02-05");
      expect(read.body.data.counter_offer.due_date).toBe("2027-02-15");
      expect(read.body.data.planner_evidence).toBeUndefined();
      await post("/" + id + "/response", {
        expected_version: 1,
        response: "ACKNOWLEDGE",
        counter_id: randomUUID(),
      }).expect(409);
      const key = randomUUID(),
        ack = {
          expected_version: 1,
          response: "ACKNOWLEDGE",
          counter_id: read.body.data.counter_offer.id,
        };
      await post("/" + id + "/response", ack, key).expect(200);
      const replay = await post("/" + id + "/response", ack, key).expect(200);
      expect(replay.body.replayed).toBe(true);
      await processAgreedCounterOffer();
      const decision = (
        await pool.query(
          "SELECT need_date::text,accepted_need_date::text FROM demand_pilot_revisions WHERE id=$1",
          [id],
        )
      ).rows[0];
      expect(decision).toEqual({
        need_date: "2027-02-05",
        accepted_need_date: "2027-02-15",
      });
    });
  },
);
