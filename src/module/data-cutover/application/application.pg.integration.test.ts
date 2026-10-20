import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { repoPath } from "../../../__tests__/helpers/repo-paths";
import type { ApplicationAdapter } from "./application.types";
const url = process.env.CERP_CUTOVER_APPLICATION_URL;
const suite = url ? describe : describe.skip;
let db: Pool;
let service: ReturnType<typeof import("./application.service")["createCutoverApplicationService"]>;
let module: typeof import("./application.service");
const batchId = "91000000-0000-4000-8000-000000000001";
const rowId = "91000000-0000-4000-8000-000000000002";
const row2 = "91000000-0000-4000-8000-000000000003";
const input = { expected_version: 1, confirm: true as const, checkpoint: { backup_reference: "verified-disposable-fixture", scope_stopped: true as const, signoffs_complete: true as const, no_external_emissions: true as const } };
const adapter: ApplicationAdapter = {
  domains: ["METROLOGY"], kind: "NATIVE_FIXTURE", mode: "CREATE", effects: ["Create one local fixture record"],
  groupKey: (row) => row.legacy_key,
  inspect: async () => [],
  apply: async (context) => {
    const targets = [];
    for (const row of context.rows) {
      const result = await context.client.query<{ id: string }>("INSERT INTO public.fixture_native_targets(reference) VALUES($1) RETURNING id::text", [row.legacy_key]);
      targets.push({ rowId: row.id, domain: row.domain, targetType: "METROLOGY", targetId: result.rows[0].id, targetReference: row.legacy_key });
    }
    return { targets };
  },
};
suite("cutover application atomic PostgreSQL command", () => {
  beforeAll(async () => {
    if (!url || process.env.DATABASE_URL !== url) throw new Error("Application fixture URL must equal DATABASE_URL");
    const parsed = new URL(url);
    if (!["127.0.0.1", "localhost"].includes(parsed.hostname) || parsed.port !== "55471" || parsed.pathname !== "/cerp_cutover_application_1710") throw new Error("Refusing non-disposable application database");
    db = new Pool({ connectionString: url });
    const identity = await db.query<{ name: string }>("SELECT current_database() AS name");
    if (identity.rows[0].name !== "cerp_cutover_application_1710") throw new Error("Unexpected database identity");
    await db.query("CREATE TABLE IF NOT EXISTS public.users(id integer PRIMARY KEY,username text NOT NULL,status text NOT NULL DEFAULT 'Active'); INSERT INTO public.users(id,username) VALUES(1,'fixture-admin') ON CONFLICT DO NOTHING; CREATE TABLE IF NOT EXISTS public.units(code text PRIMARY KEY,label text NOT NULL); CREATE TABLE IF NOT EXISTS public.fixture_native_targets(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),reference text NOT NULL UNIQUE)");
    await db.query(readFileSync(repoPath("db", "patches", "20261020_01_data_cutover_preparation_1710.sql"), "utf8"));
    await db.query(readFileSync(repoPath("db", "patches", "20261020_04_data_cutover_application_1710.sql"), "utf8"));
    module = await import("./application.service");
    service = module.createCutoverApplicationService([adapter], db, { audit: async () => undefined });
  });
  beforeEach(async () => {
    await db.query("TRUNCATE public.data_cutover_application_order_groups,public.data_cutover_application_operations,public.data_cutover_application_crosswalk,public.data_cutover_application_runs,public.data_cutover_events,public.data_cutover_commands,public.data_cutover_contributors,public.data_cutover_rows,public.data_cutover_batches,public.fixture_native_targets");
    await db.query("INSERT INTO public.data_cutover_batches(id,name,source_system,source_hash,sources,created_by,status,version,validation) VALUES($1,'Fixture lot','CLIPPER_EXCEL',$2,$3::jsonb,1,'VALIDATED',1,'{}'::jsonb)", [batchId, "a".repeat(64), JSON.stringify([{ id: "fixture", name: "fixture.xlsx", sha256: "b".repeat(64), snapshot_at: "2026-10-20T10:00:00Z" }])]);
    const values = { equipmentReference: "FIXTURE-1", designation: "Disposable fixture", equipmentStatus: "ACTIVE" };
    await db.query("INSERT INTO public.data_cutover_rows(id,batch_id,domain,legacy_key,source_id,sheet,row_number,source_values,\"values\",decision,updated_by) VALUES($1,$2,'METROLOGY','FIXTURE-1','fixture','Sheet',2,$3::jsonb,$3::jsonb,'INCLUDE',1)", [rowId, batchId, JSON.stringify(values)]);
  });
  afterAll(async () => { await (await import("../../../config/database")).default.end(); await db?.end(); });
  it("commits native record, immutable snapshot, crosswalk and receipt together; concurrent retry returns one result", async () => {
    const preview = await service.preview(batchId, 1, 1);
    expect(preview.can_apply).toBe(true);
    const [first, second] = await Promise.all([service.apply(batchId, { ...input, expected_preview_hash: preview.preview_hash }, 1, "fixture-apply-1", "fixture"), service.apply(batchId, { ...input, expected_preview_hash: preview.preview_hash }, 1, "fixture-apply-1", "fixture")]);
    expect(first.id).toBe(second.id);
    expect([first.replayed, second.replayed].sort()).toEqual([false, true]);
    const counts = await db.query("SELECT (SELECT count(*)::int FROM public.fixture_native_targets) AS native,(SELECT count(*)::int FROM public.data_cutover_application_crosswalk) AS links,(SELECT count(*)::int FROM public.data_cutover_application_runs) AS receipts");
    expect(counts.rows[0]).toEqual({ native: 1, links: 1, receipts: 1 });
    const snapshot = await db.query("SELECT values_snapshot FROM public.data_cutover_application_crosswalk");
    expect(snapshot.rows[0].values_snapshot.equipmentReference).toBe("FIXTURE-1");
    await expect(db.query("UPDATE public.data_cutover_application_crosswalk SET target_reference='changed'")).rejects.toMatchObject({ code: "23514" });
  });
  it("rolls back all native records when an adapter fails after its first write", async () => {
    const failing = module.createCutoverApplicationService([{ ...adapter, apply: async (context) => { await adapter.apply(context); throw new Error("fixture controlled failure"); } }], db, { audit: async () => undefined });
    const preview = await failing.preview(batchId, 1, 1);
    await expect(failing.apply(batchId, { ...input, expected_preview_hash: preview.preview_hash }, 1, "fixture-apply-2", "fixture")).rejects.toThrow("fixture controlled failure");
    const counts = await db.query("SELECT (SELECT count(*)::int FROM public.fixture_native_targets) AS native,(SELECT count(*)::int FROM public.data_cutover_application_crosswalk) AS links,(SELECT count(*)::int FROM public.data_cutover_application_runs) AS receipts");
    expect(counts.rows[0]).toEqual({ native: 0, links: 0, receipts: 0 });
  });
  it("rejects a changed idempotency request and never issues a second native record", async () => {
    const preview = await service.preview(batchId, 1, 1);
    await service.apply(batchId, { ...input, expected_preview_hash: preview.preview_hash }, 1, "fixture-apply-3", "fixture");
    await expect(service.apply(batchId, { ...input, checkpoint: { ...input.checkpoint, backup_reference: "different-proof" }, expected_preview_hash: preview.preview_hash }, 1, "fixture-apply-3", "fixture")).rejects.toMatchObject({ code: "CUTOVER_APPLICATION_IDEMPOTENCY_CONFLICT" });
  });
  it("blocks a previously applied source whose prepared values were changed", async () => {
    const preview = await service.preview(batchId, 1, 1);
    await service.apply(batchId, { ...input, expected_preview_hash: preview.preview_hash }, 1, "fixture-apply-4", "fixture");
    await db.query("UPDATE public.data_cutover_rows SET \"values\"=jsonb_set(\"values\",'{designation}','\"Changed\"'::jsonb),version=version+1 WHERE id=$1", [rowId]);
    const changed = await service.preview(batchId, 1, 1);
    expect(changed.can_apply).toBe(false);
    expect(changed.blockers.some((issue) => issue.code === "CUTOVER_SOURCE_ALREADY_APPLIED_CHANGED")).toBe(true);
  });
  it("resolves a lost commit acknowledgement from the durable receipt instead of creating a second record", async () => {
    const flaky = Object.create(db) as Pool;
    flaky.connect = (async () => {
      const client = await db.connect();
      const originalQuery = client.query.bind(client);
      client.query = (async (...args: unknown[]) => {
        const result = await (originalQuery as (...params: unknown[]) => Promise<unknown>)(...args);
        if (args[0] === "COMMIT") throw new Error("fixture lost commit acknowledgement");
        return result;
      }) as typeof client.query;
      return client;
    }) as typeof flaky.connect;
    const reconciled = module.createCutoverApplicationService([adapter], flaky, { audit: async () => undefined });
    const preview = await service.preview(batchId, 1, 1);
    const result = await reconciled.apply(batchId, { ...input, expected_preview_hash: preview.preview_hash }, 1, "fixture-lost-ack", "fixture");
    const replay = await service.apply(batchId, { ...input, expected_preview_hash: preview.preview_hash }, 1, "fixture-lost-ack", "fixture");
    expect(replay.id).toBe(result.id);
    expect(replay.replayed).toBe(true);
    expect((await db.query("SELECT count(*)::int AS count FROM public.fixture_native_targets")).rows[0].count).toBe(1);
  });
  it("validates planned dependencies but supplies only real IDs to the native writers", async () => {
    await db.query("DELETE FROM public.data_cutover_rows WHERE batch_id=$1", [batchId]);
    await db.query("INSERT INTO public.units(code,label) VALUES('u','Pièce') ON CONFLICT DO NOTHING");
    const references = [
      { id: rowId, domain: "CUSTOMER", key: "CLI-1", values: { customerCode: "001", name: "Fixture client", resolution: "CREATE", country: "FR", address: "1 rue de la Recette", postalCode: "69001", city: "Lyon", creationDate: "2026-10-20", deliverySameAsBilling: true } },
      { id: row2, domain: "ARTICLE", key: "ART-1", values: { articleReference: "00042", designation: "Fixture article", category: "achat", resolution: "CREATE", unit: "u", familyCode: "ACH", lotTracked: false } },
    ];
    for (const row of references) await db.query("INSERT INTO public.data_cutover_rows(id,batch_id,domain,legacy_key,source_id,sheet,row_number,source_values,\"values\",decision,updated_by) VALUES($1,$2,$3,$4,'fixture','Sheet',2,$5::jsonb,$5::jsonb,'INCLUDE',1)", [row.id, batchId, row.domain, row.key, JSON.stringify(row.values)]);
    let inspectedPlannedDependency = false;
    let writerReceivedRealDependency = false;
    const customer: ApplicationAdapter = { ...adapter, domains: ["CUSTOMER"], kind: "CUSTOMER_FIXTURE", plannedTargetType: "CUSTOMER" };
    const article: ApplicationAdapter = {
      ...adapter, domains: ["ARTICLE"], kind: "ARTICLE_FIXTURE",
      inspect: async (context) => { const customer = context.targets.get("CUSTOMER:001"); if (!customer) return [{ field: null, code: "MISSING_DEPENDENCY", message: "Missing dependency" }]; if (customer.planned) inspectedPlannedDependency = true; return []; },
      apply: async (context) => { const customer = context.targets.get("CUSTOMER:001"); expect(customer?.planned).toBeUndefined(); expect((await context.client.query("SELECT 1 FROM public.fixture_native_targets WHERE id=$1::uuid", [customer?.id])).rows).toHaveLength(1); writerReceivedRealDependency = true; return adapter.apply(context); },
    };
    const dependent = module.createCutoverApplicationService([customer, article], db, { audit: async () => undefined });
    const preview = await dependent.preview(batchId, 1, 1);
    expect(preview.can_apply).toBe(true);
    expect(inspectedPlannedDependency).toBe(true);
    await dependent.apply(batchId, { ...input, expected_preview_hash: preview.preview_hash }, 1, "fixture-dependencies", "fixture");
    expect(writerReceivedRealDependency).toBe(true);
  });
});
