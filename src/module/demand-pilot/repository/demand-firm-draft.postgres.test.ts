import { createPilotFixtureArticle } from "../../../__tests__/fixtures/demand-pilot.fixture";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pool from "../../../config/database";
import { importDemand } from "./demand-ingest.repository";
import { prepareFirmDraft } from "../services/demand-pilot-firm-draft.service";

const url = new URL(
  process.env.DATABASE_URL ?? "postgres://localhost/no_database",
);
const isolated =
  process.env.CERP_DEMAND_POSTGRES_TEST === "1" &&
  process.env.CERP_E2E_ISOLATED === "1" &&
  ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
  url.pathname === "/cerp_test";
const client = "DFT",
  article = randomUUID(),
  code = `DFD-${randomUUID().slice(0, 8)}`;
let actor = 0;
const source = (
  line: string,
  site: string = code,
  order: string = "ORDER-A",
) => ({
  external_site: site,
  external_order_key: order,
  external_line_key: line,
  external_schedule_key: "SCH",
  source_version: "W1",
  source_as_of: "2027-01-04T09:00:00Z",
  kind: "FIRM" as const,
  quantity: 10,
  unit: "U",
  quantity_basis: "REMAINING" as const,
  need_date: "2027-02-08",
  article_code: code,
});

describe.skipIf(!isolated)("Firm draft against loopback PostgreSQL", () => {
  beforeAll(async () => {
    actor = (
      await pool.query(
        "SELECT id FROM public.users WHERE is_superadmin LIMIT 1",
      )
    ).rows[0].id;
    await pool.query(
      "INSERT INTO public.clients(client_id,client_code,company_name) VALUES($1,$2,'Draft PG isolated') ON CONFLICT(client_id) DO NOTHING",
      [client, client],
    );
    const tx = await pool.connect();
    try {
      await tx.query("BEGIN");
      await createPilotFixtureArticle(tx, client, actor, article, code);
      await tx.query("COMMIT");
    } catch (e) {
      await tx.query("ROLLBACK");
      throw e;
    } finally {
      tx.release();
    }
  });
  afterAll(async () => pool.end());
  it("creates one tracked canonical multi-line draft and replays the intent", async () => {
    const imported = await importDemand({
      clientId: client,
      rows: [source("10"), source("20")],
      completeSnapshot: false,
      actor: { userId: actor },
      idempotencyKey: randomUUID(),
    });
    const rows = (
      await pool.query<any>(
        "SELECT id::text FROM public.demand_pilot_revisions WHERE import_id=$1::uuid ORDER BY external_line_key",
        [imported.import_id],
      )
    ).rows;
    const body = {
      client_id: client,
      revision_ids: rows.map((r) => r.id),
      lines: rows.map((r: any, i: number) => ({
        revision_id: r.id,
        designation: `Ligne ${i + 1}`,
        prix_unitaire_ht: 12.5,
        taux_tva: 20,
        remise_ligne: 0,
      })),
    };
    const intent = randomUUID();
    const created = await prepareFirmDraft(body, actor, intent);
    expect(created.replayed).toBe(false);
    expect(created.commande_id).toBeTypeOf("number");
    const replay = await prepareFirmDraft(body, actor, intent);
    expect(replay).toMatchObject({
      replayed: true,
      commande_id: created.commande_id,
    });
    const tracked = await pool.query(
      "SELECT 1 FROM public.demand_pilot_firm_draft_lines WHERE revision_id=ANY($1::uuid[])",
      [rows.map((r: any) => r.id)],
    );
    expect(tracked.rowCount).toBe(2);
    const count = await pool.query(
      "SELECT count(*)::int count FROM public.commande_ligne WHERE commande_id=$1::bigint",
      [created.commande_id],
    );
    expect(count.rows[0].count).toBe(2);
  });
});
