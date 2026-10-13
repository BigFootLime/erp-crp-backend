import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ audit: vi.fn(), query: vi.fn(), resolve: vi.fn(), frozen: vi.fn(), connect: vi.fn(), receipt: null as null | Record<string, unknown>, execution: null as null | Record<string, unknown>, pending: false }));
vi.mock("../../../config/database", () => ({ default: { query: mocks.query, connect: mocks.connect } }));
vi.mock("../../../shared/realtime/realtime-outbox-transaction", () => ({ withRealtimeOutboxTransaction: async (client: unknown, run: (tx: unknown) => unknown) => run(client) }));
vi.mock("../../../shared/realtime/realtime-outbox.service", () => ({ enqueueEntityChanged: vi.fn() }));
vi.mock("../../../shared/codes/code-generator.service", () => ({ generateTransactionalBusinessCode: async () => "CQ-FICTIF" }));
vi.mock("../../audit-logs/repository/audit-logs.repository", () => ({ repoInsertAuditLog: mocks.audit }));
vi.mock("../../stock/repository/stock-lane-routing.repository", () => ({ lockStockLaneTopology: vi.fn() }));
vi.mock("./quality-of-context", () => ({
  isOfQualitySource: (b: { source_type: string }) => b.source_type === "OF_OPERATION" || b.source_type === "OF",
  resolveQualityOfContext: mocks.resolve, readFrozenQualityPlanId: mocks.frozen,
  readQualityOfIdentity: vi.fn(), qualityOfPopulationCeiling: vi.fn(),
}));
import { repoCreateExecution, repoPreviewExecution } from "./quality-360.repository";
const op = "11111111-1111-4111-8111-111111111111", plan = "22222222-2222-4222-8222-222222222222", control = "33333333-3333-4333-8333-333333333333";
const body = { source_type: "OF_OPERATION" as const, source_id: op, of_id: 103, operation_id: op, trigger: "FINAL" as const, population: 4, unite: "u" };
const planRow = { id: plan, code: "PC-FROZEN-V1", version: 1, label: "Contrôle platine", status: "PUBLISHED", trigger_type: "FINAL", article_id: null, piece_technique_id: op, piece_version_id: op, famille_id: null, operation_code: null, fournisseur_id: null, published_at: "2026-10-11T10:00:00Z", sampling_rule: "PERCENT", sampling_value: "100", sampling_justification: null };
const characteristic = { characteristic_key: "PLAT-LONGUEUR", position: 1, label: "Longueur", characteristic_type: "DIMENSIONAL", value_kind: "NUMERIC", unit: "mm", nominal: "50", tolerance_min: "-0.1", tolerance_max: "0.1", precision_digits: 2, expected_boolean: null, allowed_values: null, criticality: "MAJOR", mandatory: true, requires_instrument: true, instrument_category: "PIED_A_COULISSE", method: null, acceptance_rule: null, sampling_rule: "PERCENT", sampling_value: "100", sampling_justification: null, trigger_type: "FINAL" };
beforeEach(() => {
  mocks.receipt = null; mocks.execution = null; mocks.pending = false;
  mocks.audit.mockReset().mockResolvedValue({ id: "audit-fictif" });
  mocks.resolve.mockReset().mockImplementation(async (_q, b) => ({ ...b, operation_id: op, article_id: op, piece_technique_id: op, piece_version_id: op, operation_code: "30" }));
  mocks.frozen.mockReset().mockResolvedValue(plan);
  mocks.connect.mockReset().mockResolvedValue({ query: mocks.query });
  mocks.query.mockReset().mockImplementation(async (sql: string, values: unknown[] = []) => {
    if (sql.includes("FROM public.quality_control_plan p WHERE p.id")) return { rows: [planRow] };
    if (sql.includes("FROM public.quality_control_plan_characteristic")) return { rows: [characteristic] };
    if (sql.includes("SELECT request_hash, result_payload")) return { rows: mocks.receipt ? [mocks.receipt] : [] };
    if (sql.includes("SELECT id::text,reference FROM public.quality_control")) return { rows: mocks.pending ? [{ id: control, reference: "CQ-ALREADY-OPEN" }] : [] };
    if (sql.includes("INSERT INTO public.quality_control (")) {
      mocks.execution = { id: control, reference: values[0], status: "IN_PROGRESS", result: null, verdict: "EN_ATTENTE", verdict_computed: "EN_ATTENTE", control_type: "FINAL", trigger_type: "FINAL", source_type: "OF_OPERATION", source_id: op, plan_id: plan, plan_version: 1, plan_code: "PC-FROZEN-V1", plan_snapshot: JSON.parse(String(values[7])), plan_snapshot_sha256: values[8], unite: "u", qty_population: "4", qty_controlled: "0", qty_conforming: "0", qty_released: "0", qty_held: "0", qty_scrapped: "0", qty_reworked: "0", qty_sorted: "0", qty_returned: "0", qty_consumed: "0", validation_date: null, controlled_by: 1, correlation_id: control };
      return { rows: [{ id: control, correlation_id: control }] };
    }
    if (sql.includes("INSERT INTO public.quality_command_receipts")) mocks.receipt = { request_hash: values[2], result_payload: JSON.parse(String(values[7])) };
    if (sql.includes("FROM public.quality_control qc")) return { rows: mocks.execution ? [mocks.execution] : [] };
    if (sql.includes("INSERT INTO public.quality_event_log")) return { rows: [{ id: control, created_at: "2026-10-11T13:55:00Z" }] };
    if (sql.includes("FROM public.quality_control_plan p") && !sql.includes("WHERE p.id")) throw Error("Latest-plan resolution must not run for an OF");
    return { rows: [] };
  });
});
const actor = { user_id: 1, role: "Responsable qualite", request_id: null } as never;
describe("Canonical OF control preview and creation", () => {
  it("uses the pinned plan in session preview even with the native flag false", async () => {
    const preview = await repoPreviewExecution(body, false);
    expect(preview.plan).toEqual({ id: plan, code: "PC-FROZEN-V1", version: 1 });
    expect(preview.characteristics[0]?.required_samples).toBe(4);
    expect(mocks.frozen).toHaveBeenCalledWith(expect.anything(), 103, op, "FINAL");
  });
  it("stores the operation FK and replays the same receipt without a second control", async () => {
    const preview = await repoPreviewExecution(body);
    const input = { body: { ...body, preview_sha256: preview.snapshot_sha256 }, actor, idempotencyKey: "quality-of-103-create" };
    const first = await repoCreateExecution(input);
    const second = await repoCreateExecution(input);
    expect(second.id).toBe(first.id); expect(first.ledger).toMatchObject({ population: 4, controlled: 0, released: 0 });
    const inserts = mocks.query.mock.calls.filter(([sql]) => String(sql).includes("INSERT INTO public.quality_control ("));
    expect(inserts).toHaveLength(1); expect(inserts[0]![0]).toContain("$23::uuid"); expect(inserts[0]![1][22]).toBe(op);
    expect(mocks.resolve).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ source_id: op }), true);
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ tx: expect.anything(),
      body: expect.objectContaining({ entity_id: control }) }));
  });
  it("refuses to publish a successful receipt when the mandatory audit insertion is missing", async () => {
    mocks.audit.mockResolvedValueOnce(null);
    const preview = await repoPreviewExecution(body);
    await expect(repoCreateExecution({ body: { ...body, preview_sha256: preview.snapshot_sha256 }, actor,
      idempotencyKey: "quality-of-103-audit-missing" })).rejects.toThrow("QUALITY_AUDIT_INSERT_FAILED");
    expect(mocks.receipt).toBeNull();
  });
  it("refuses a stale preview before any control is inserted", async () => {
    await expect(repoCreateExecution({ body: { ...body, preview_sha256: "a".repeat(64) }, actor, idempotencyKey: "quality-of-103-stale" })).rejects.toMatchObject({ status: 409 });
    expect(mocks.query.mock.calls.filter(([sql]) => String(sql).includes("INSERT INTO public.quality_control ("))).toHaveLength(0);
  });
  it("returns the existing pending execution as an actionable conflict", async () => {
    mocks.pending = true;
    await expect(repoCreateExecution({ body: { ...body, preview_sha256: "a".repeat(64) }, actor, idempotencyKey: "quality-of-103-pending" })).rejects.toMatchObject({ status: 409, code: "QUALITY_OF_CONTROL_PENDING", details: { control_id: control } });
  });
});
