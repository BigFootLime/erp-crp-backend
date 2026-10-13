import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ connect: vi.fn(), query: vi.fn(), release: vi.fn(), receipt: vi.fn(), save: vi.fn(), event: vi.fn(), audit: vi.fn(), realtime: vi.fn() }));
vi.mock("../../../config/database", () => ({ default: { connect: mocks.connect } }));
vi.mock("./workflow.repository.shared", () => ({ acquireFinanceIdempotency: mocks.receipt, saveFinanceReceipt: mocks.save,
  insertFinanceEvent: mocks.event, insertGlobalFinanceAudit: mocks.audit, newCorrelationId: () => "10000000-0000-4000-8000-000000000001" }));
vi.mock("../../../shared/realtime/realtime-outbox.service", () => ({ enqueueEntityChanged: mocks.realtime }));
import { runProformaCommand } from "./proforma-transaction.repository";
import { financeRequestHash } from "../domain/finance-policy";
import { HttpError } from "../../../utils/httpError";
const actor = { userId: 7, requestId: "recipe-request", path: "/proformas" };
const command = { actor, idempotencyKey: "recipe-proforma-command", commandType: "PROFORMA_DRAFT_CREATE", payload: { client_id: "CUSTOMER" } };
const work = vi.fn();
beforeEach(() => {
  for(const mock of Object.values(mocks)) mock.mockReset(); work.mockReset();
  mocks.connect.mockResolvedValue({ query: mocks.query, release: mocks.release }); mocks.query.mockResolvedValue({ rows: [] });
  mocks.receipt.mockResolvedValue({ replay: null });
  work.mockResolvedValue({ aggregateId: "PF-ID", deliveryAllocationIds: [12], result: { id: "PF-ID", status: "DRAFT" } });
});

describe("proforma transactional command lifecycle", () => {
  it("commits business result, audit, replay receipt and module invalidations together", async () => {
    const result = await runProformaCommand({ ...command, work });
    expect(result).toMatchObject({ id: "PF-ID", status: "DRAFT", idempotent_replay: false });
    expect(mocks.event).toHaveBeenCalledWith(expect.objectContaining({ aggregateType: "PROFORMA", aggregateId: "PF-ID" }));
    expect(mocks.audit).toHaveBeenCalledTimes(1); expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(mocks.realtime.mock.calls.map(call => call[1].module)).toEqual(["facturation", "livraisons"]);
    expect(mocks.query.mock.calls.map(call => call[0])).toContain("COMMIT");
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });
  it("a retry returns the saved result without reissuing or touching business rows", async () => {
    mocks.receipt.mockResolvedValue({ replay: { id: "PF-ID", correlation_id: "EARLIER", status: "DRAFT" } });
    expect(await runProformaCommand({ ...command, work })).toMatchObject({ idempotent_replay: true, correlation_id: "EARLIER" });
    expect(work).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled(); expect(mocks.realtime).not.toHaveBeenCalled();
  });
  it("rolls back a failed business decision and records no success receipt", async () => {
    work.mockRejectedValue(new HttpError(409,"PROFORMA_PREVIEW_CHANGED","Actualisez l'aperçu."));
    await expect(runProformaCommand({ ...command, work })).rejects.toMatchObject({ code: "PROFORMA_PREVIEW_CHANGED" });
    expect(mocks.query.mock.calls.map(call => call[0])).toContain("ROLLBACK"); expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.query.mock.calls.map(call => call[0])).not.toContain("COMMIT");
  });
  it.each(["23505","23503","23514","55000"])("returns an actionable conflict for a raced SQL guard %s", code => {
    work.mockRejectedValue(Object.assign(new Error("constraint"),{code}));
    return expect(runProformaCommand({ ...command, work })).rejects.toMatchObject({ status: 409, code: "PROFORMA_CONCURRENT_CHANGE" });
  });
  it("does not hide unexpected programming errors", async () => {
    work.mockRejectedValue(new Error("unexpected failure"));
    await expect(runProformaCommand({ ...command, work })).rejects.toThrow("unexpected failure");
  });
  it("a missing commit acknowledgement is reconciled against the durable command receipt", async () => {
    mocks.query.mockImplementation(async (sql: string) => { if(sql==='COMMIT') throw Object.assign(new Error("connection reset"),{code:'ECONNRESET'}); return {rows:[]}; });
    const verifier = { query: vi.fn().mockResolvedValue({ rows: [{ request_hash: financeRequestHash(command.commandType,command.payload) }] }), release: vi.fn() };
    mocks.connect.mockResolvedValueOnce({ query: mocks.query, release: mocks.release }).mockResolvedValueOnce(verifier);
    expect(await runProformaCommand({ ...command, work })).toMatchObject({ id: "PF-ID", idempotent_replay: false });
    expect(mocks.release).toHaveBeenCalledWith(true); expect(verifier.release).toHaveBeenCalledTimes(1);
  });
  it("does not invent success when commit reconciliation is unavailable", async () => {
    mocks.query.mockImplementation(async (sql: string) => { if(sql==='COMMIT') throw new Error("lost acknowledgement"); return {rows:[]}; });
    mocks.connect.mockResolvedValueOnce({ query: mocks.query, release: mocks.release }).mockRejectedValueOnce(new Error("unavailable"));
    await expect(runProformaCommand({ ...command, work })).rejects.toMatchObject({ status: 503, code: "REALTIME_COMMIT_OUTCOME_UNKNOWN" });
  });
  it("fails before the connection is borrowed without an idempotency key", async () => {
    await expect(runProformaCommand({ ...command, idempotencyKey: undefined, work })).rejects.toMatchObject({ status: 400 });
    expect(mocks.connect).not.toHaveBeenCalled();
  });
});
