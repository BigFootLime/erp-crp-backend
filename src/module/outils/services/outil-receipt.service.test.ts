import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(), addToStock: vi.fn(), logMouvementStock: vi.fn(), audit: vi.fn(), outbox: vi.fn(),
}));

vi.mock("../../../config/database", () => ({ default: { connect: mocks.connect, query: vi.fn() } }));
vi.mock("../repository/outil.repository", () => ({ outilRepository: { addToStock: mocks.addToStock, logMouvementStock: mocks.logMouvementStock } }));
vi.mock("../../audit-logs/repository/audit-logs.repository", () => ({ repoInsertAuditLog: mocks.audit }));
vi.mock("../../../shared/realtime/realtime-outbox.service", () => ({ enqueueEntityChanged: mocks.outbox }));

import { outilService } from "./outil.service";

type State = { schema: boolean; replay?: { request_hash: string; result: object }; actualFails?: boolean; calls: string[] };
const payload = (extra = {}) => ({ id_outil: 7, quantite: 2, prix_unitaire_ht: 12.5, fournisseur_id: "11111111-1111-1111-1111-111111111111", purchased_at: "2026-10-25", devise: "EUR", unite: "piece", reception_ref: "BL-1", idempotency_key: "receipt-key-1", utilisateur: "qa", user_id: 4, ...extra });

function clientFor(state: State) {
  const client = {
    release: vi.fn(),
    query: vi.fn(async (sql: string, values?: unknown[]) => {
      state.calls.push(sql);
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK" || sql.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (sql.includes("to_regclass('public.outillage_tool_actual_purchase_prices')")) return { rows: [{ table_name: state.schema ? "outillage_tool_actual_purchase_prices" : null, idempotence_table_name: state.schema ? "outillage_tool_receipt_idempotence" : null }] };
      if (sql.includes("SELECT request_hash,result FROM outillage_tool_receipt_idempotence")) return { rows: state.replay ? [state.replay] : [] };
      if (sql.includes("FROM fournisseurs f JOIN fournisseur_domaine_lien")) return { rows: [{ "?column?": 1 }] };
      if (sql.includes("INSERT INTO outillage_tool_actual_purchase_prices")) {
        if (state.actualFails) throw new Error("actual-price-write-failed");
        return { rows: [] };
      }
      if (sql.includes("INSERT INTO outillage_tool_receipt_idempotence")) return { rows: [] };
      throw new Error(`unexpected SQL: ${sql}`);
    }),
  };
  return client;
}

describe("outilService.reapprovisionner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.logMouvementStock.mockResolvedValue({ id: "m1", date: "2026-10-25T12:00:00Z" });
    mocks.audit.mockResolvedValue(null); mocks.outbox.mockResolvedValue("event");
  });

  it("replays the same actor/key/body without a second stock or actual-price write", async () => {
    const first: State = { schema: true, calls: [] };
    const firstClient = clientFor(first);
    mocks.connect.mockResolvedValueOnce(firstClient);
    const created = await outilService.reapprovisionner(payload());
    expect(created.idempotent_replay).toBe(false);
    const idempotenceInsert = first.calls.find((sql) => sql.includes("INSERT INTO outillage_tool_receipt_idempotence"))!;
    expect(idempotenceInsert).toBeTruthy();
    const persistedReplay = { request_hash: "", result: { success: true, id_outil: 7, reception_ref: "BL-1", actual_purchase_price_recorded: true } };
    const second: State = { schema: true, replay: persistedReplay, calls: [] };
    // Capture the persisted hash from the real SQL parameter list instead of duplicating service hashing logic.
    persistedReplay.request_hash = String(firstClient.query.mock.calls.find((call) => String(call[0]).includes("INSERT INTO outillage_tool_receipt_idempotence"))?.[1]?.[2]);
    mocks.connect.mockResolvedValueOnce(clientFor(second));
    const replay = await outilService.reapprovisionner(payload());
    expect(replay.idempotent_replay).toBe(true);
    expect(mocks.addToStock).toHaveBeenCalledTimes(1);
    expect(mocks.logMouvementStock).toHaveBeenCalledTimes(1);
    expect([...first.calls, ...second.calls].filter((sql) => sql.includes("INSERT INTO outillage_tool_actual_purchase_prices"))).toHaveLength(1);
  });

  it("rejects a changed body for an existing idempotency key before stock", async () => {
    const state: State = { schema: true, replay: { request_hash: "different", result: {} }, calls: [] }; mocks.connect.mockResolvedValue(clientFor(state));
    await expect(outilService.reapprovisionner(payload())).rejects.toMatchObject({ status: 409, code: "IDEMPOTENCY_KEY_REUSED" });
    expect(mocks.addToStock).not.toHaveBeenCalled();
    expect(state.calls).toContain("ROLLBACK");
  });

  it("rolls back without writing an actual price when stock refuses pending inventory", async () => {
    mocks.addToStock.mockRejectedValueOnce(Object.assign(new Error("pending"), { status: 409, code: "INVENTORY_REQUIRED" }));
    const state: State = { schema: true, calls: [] }; mocks.connect.mockResolvedValue(clientFor(state));
    await expect(outilService.reapprovisionner(payload())).rejects.toMatchObject({ code: "INVENTORY_REQUIRED" });
    expect(state.calls).toContain("ROLLBACK");
    expect(state.calls.some((sql) => sql.includes("INSERT INTO outillage_tool_actual_purchase_prices"))).toBe(false);
  });

  it("rolls back a stock receipt when actual-price persistence fails", async () => {
    const state: State = { schema: true, actualFails: true, calls: [] }; mocks.connect.mockResolvedValue(clientFor(state));
    await expect(outilService.reapprovisionner(payload())).rejects.toThrow("actual-price-write-failed");
    expect(mocks.addToStock).toHaveBeenCalledOnce();
    expect(state.calls).toContain("ROLLBACK");
  });

  it("returns an explicit 503 before stock when the receipt schema is absent", async () => {
    const state: State = { schema: false, calls: [] }; mocks.connect.mockResolvedValue(clientFor(state));
    await expect(outilService.reapprovisionner(payload())).rejects.toMatchObject({ status: 503, code: "OUTILLAGE_RECEIPT_SCHEMA_UNAVAILABLE" });
    expect(mocks.addToStock).not.toHaveBeenCalled();
    expect(state.calls).toContain("ROLLBACK");
  });
});
