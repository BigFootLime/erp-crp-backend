import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import pool from "../../../config/database";
import { importDemand } from "./demand-ingest.repository";
import { getDemand, listDemand } from "./demand-pilot.repository";
import { calculateIndustrialPlan } from "../../planning/domain/industrial-plan";
import { readIndustrialInput } from "../../planning/repository/industrial-input.repository";
import {
  enqueueIndustrialRun,
  industrialRunById,
  processIndustrialRun,
  validateIndustrialRun,
  industrialTx,
} from "../../planning/services/industrial-runs.service";
import {
  readIndustrialPolicy,
  setIndustrialPolicy,
} from "../../planning/repository/industrial-policy.repository";
import { demandRowSchema } from "../validators/demand-pilot.validators";
const url = new URL(
  process.env.DATABASE_URL ?? "postgres://localhost/no_database",
);
const isolated =
  process.env.CERP_DEMAND_POSTGRES_TEST === "1" &&
  process.env.CERP_E2E_ISOLATED === "1" &&
  ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
  url.pathname === "/cerp_test";
const client = "DQA",
  article = randomUUID(),
  prefix = "PG-" + randomUUID();
let actor: number;
const row = (
  site: string,
  line: string,
  version = "W1",
  epoch = "2027-01-04T09:00:00Z",
) =>
  demandRowSchema.parse({
    external_site: prefix + site,
    external_order_key: "DEMO-PO",
    external_line_key: line,
    external_schedule_key: "A",
    source_version: version,
    source_as_of: epoch,
    article_code: prefix,
    unit: "U",
    kind: "FIRM",
    quantity: 10,
    need_date: "2027-02-08",
    quantity_basis: "REMAINING",
  });
const send = (
  rows: ReturnType<typeof row>[],
  key = randomUUID(),
  completeSnapshot = false,
) =>
  importDemand({
    clientId: client,
    rows,
    completeSnapshot,
    actor: { userId: actor },
    idempotencyKey: key,
  });
describe.skipIf(!isolated)(
  "Pilot on migrated, seeded loopback PostgreSQL",
  () => {
    beforeAll(async () => {
      actor = (
        await pool.query(
          "SELECT id FROM public.users WHERE is_superadmin LIMIT 1",
        )
      ).rows[0].id;
      await pool.query(
        "INSERT INTO public.clients(client_id,client_code,company_name) VALUES($1::text,$1::text,'Test atelier isolé') ON CONFLICT(client_id) DO NOTHING",
        [client],
      );
      await industrialTx(async (tx) => {
        await tx.query(
          "INSERT INTO public.articles(id,root_article_id,version_number,plan_index,code,designation,article_type,unite,article_category,status,commercial_scope,is_sold,family_code) VALUES($1,$1,1,1,$2,'Pièce de recette isolée','PURCHASED','u','achat','VALIDE','CLIENTS',true,$2)",
          [article, prefix],
        );
        await tx.query(
          "INSERT INTO public.article_client_links(article_id,client_id,created_by) VALUES($1,$2,$3)",
          [article, client, actor],
        );
      });
    });
    afterAll(async () => {
      await pool.end();
    });
    it("records two lines once under parallel imports and treats a recaptured identical week as unchanged", async () => {
      const a = row("weekly", "10"),
        b = row("weekly", "20"),
        key = randomUUID();
      const pair = await Promise.all([send([a, b], key), send([b, a], key)]);
      expect(pair.filter((r) => r.replayed)).toHaveLength(1);
      expect(pair[0].import_id).toBe(pair[1].import_id);
      expect(pair[0].created).toBe(2);
      const next = [a, b].map((r) => ({
        ...r,
        source_version: "W2",
        source_as_of: "2027-01-11T09:00:00Z",
      }));
      await expect(send(next)).resolves.toMatchObject({
        created: 0,
        unchanged: 2,
        missing: 0,
      });
      await expect(
        send([{ ...a, quantity: 11 }, b], key),
      ).rejects.toMatchObject({ status: 409 });
      await expect(
        send([
          { ...a, source_version: "W0", source_as_of: "2027-01-01T00:00:00Z" },
        ]),
      ).rejects.toMatchObject({ status: 409 });
    });
    it("leaves an omitted delta untouched, records missing rows of a full snapshot only for review, and changes one schedule", async () => {
      const a = row("missing", "10"),
        b = row("missing", "20");
      await send([a, b]);
      const changed = {
        ...a,
        quantity: 7,
        source_version: "W2",
        source_as_of: "2027-01-11T00:00:00Z",
      };
      await expect(send([changed])).resolves.toMatchObject({
        created: 1,
        missing: 0,
      });
      const complete = {
        ...changed,
        source_version: "W3",
        source_as_of: "2027-01-18T00:00:00Z",
      };
      await expect(send([complete], randomUUID(), true)).resolves.toMatchObject(
        { created: 0, missing: 1 },
      );
      const rows = (
        await listDemand({ clientId: client, page: 1, pageSize: 200 })
      ).data.filter((r) => r.external_site === a.external_site);
      expect(rows).toHaveLength(2);
      const missing = rows.find((r) => r.external_line_key === "20")!;
      expect(missing).toMatchObject({
        status: "REVIEW",
        diff_type: "REMOVED",
        quantity: "10.000",
      });
      expect(await getDemand(client, missing.id)).toHaveProperty(
        "before_snapshot",
      );
    });
    it("computes a version against actual article data, then refuses a validation after policy revision", async () => {
      const today = (
        await pool.query(
          "SELECT (now() AT TIME ZONE 'Europe/Paris')::date::text AS today",
        )
      ).rows[0].today;
      const input = await industrialTx((tx) =>
        readIndustrialInput(tx, client, today),
      );
      expect(input.articles.some((a) => a.id === article)).toBe(true);
      expect(calculateIndustrialPlan(input).issues).toBeDefined();
      const run = await enqueueIndustrialRun(
        {
          client_id: client,
          start: today,
          label: "Test figé",
          capacity_percent: 100,
          months: 18,
          weeks: 26,
        },
        actor,
      );
      for (let i = 0; i < 20; i++) {
        if ((await industrialRunById(run.id)).status !== "QUEUED") break;
        await processIndustrialRun();
      }
      expect((await industrialRunById(run.id)).status).toBe("READY");
      await industrialTx(async (tx) => {
        const rule = await readIndustrialPolicy(tx, client);
        return setIndustrialPolicy(tx, actor, {
          client_id: client,
          auto_enabled: false,
          risk_limit_eur: 50,
          expected_version: rule.version,
        });
      });
      await expect(validateIndustrialRun(run.id, actor)).rejects.toMatchObject({
        code: "PLAN_STALE",
      });
    });
  },
);
