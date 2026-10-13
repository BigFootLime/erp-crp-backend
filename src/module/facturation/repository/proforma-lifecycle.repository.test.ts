import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ tx: { query: vi.fn() }, pool: { query: vi.fn() }, lock: vi.fn(), sources: vi.fn(), preview: vi.fn(), persist: vi.fn() }));
vi.mock("../../../config/database", () => ({ default: mocks.pool }));
vi.mock("./proforma-command.repository", () => ({ lockProforma: mocks.lock }));
vi.mock("./proforma-draft-content.repository", () => ({ persistProformaDraftContentTx: mocks.persist }));
vi.mock("./proforma-preview.repository", () => ({ buildProformaPreview: mocks.preview }));
vi.mock("./proforma-source.repository", () => ({ readProformaOrderSources: mocks.sources }));
vi.mock("./proforma-transaction.repository", () => ({ runProformaCommand: async (args: {
  work: (tx: typeof mocks.tx, correlationId: string) => Promise<{ result: Record<string, unknown> }>;
}) => ({ ...(await args.work(mocks.tx, "qualification-correlation")).result, correlation_id: "qualification-correlation", idempotent_replay: false }) }));
import { repoCancelProforma, repoPreviewProformaChanges, repoRefreshProforma } from "./proforma-lifecycle.repository";

const id = "12680000-0000-4000-8000-000000000001", hash = "a".repeat(64);
const selection = { client_id: "901", currency: "EUR", affairs: [{ allocation_id: 12, billing_parts: [{ billed_client_id: "902", quantity: "100" }] }] };
const context = { id, actor: { userId: 7, requestId: "qualification", path: "/proformas" }, idempotencyKey: "qualification-lifecycle" };
const draft = { id, reference: "PF-QUAL1268", status: "DRAFT", row_version: 2, client_id: "901", currency: "EUR", preview_hash: "b".repeat(64),
  preview_payload: { affairs: [{ allocation_id: 12 }, { allocation_id: 13 }] } };
const refresh = { ...selection, expected_version: 2, preview_hash: hash, confirm: true as const };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.lock.mockResolvedValue(draft); mocks.sources.mockResolvedValue([{ allocation_id: 12, has_active_delivery: false }, { allocation_id: 13, has_active_delivery: false }]);
  mocks.preview.mockResolvedValue({ ...selection, preview_hash: hash }); mocks.persist.mockResolvedValue(undefined);
  mocks.tx.query.mockResolvedValue({ rows: [] }); mocks.pool.query.mockResolvedValue({ rows: [draft] });
});
describe("proforma lifecycle with server-owned source evidence", () => {
  it("does not prepare edits to an issued commercial snapshot", async () => {
    mocks.pool.query.mockResolvedValue({ rows: [{ ...draft, status: "ISSUED" }] });
    await expect(repoPreviewProformaChanges(id, selection)).rejects.toMatchObject({ code: "PROFORMA_NOT_DRAFT" });
    expect(mocks.preview).not.toHaveBeenCalled();
  });
  it("previews edited selections against their own proforma binding", async () => {
    await repoPreviewProformaChanges(id, selection);
    expect(mocks.preview).toHaveBeenCalledWith(mocks.pool, selection, false, id);
  });
  it("rejects identity changes even when quantities and hash are valid", async () => {
    await expect(repoRefreshProforma({ ...context, input: { ...refresh, currency: "USD" } })).rejects.toMatchObject({ code: "PROFORMA_IDENTITY_CHANGED" });
    expect(mocks.persist).not.toHaveBeenCalled();
  });
  it("does not erase a removed affair already included in a BL", async () => {
    mocks.sources.mockResolvedValue([{ allocation_id: 13, has_active_delivery: true }]);
    await expect(repoRefreshProforma({ ...context, input: refresh })).rejects.toMatchObject({ code: "PROFORMA_AFFAIR_DELIVERY_EXISTS" });
    expect(mocks.tx.query).not.toHaveBeenCalled();
  });
  it("rejects source changes discovered after the caller's preview", async () => {
    mocks.preview.mockResolvedValue({ ...selection, preview_hash: "c".repeat(64) });
    await expect(repoRefreshProforma({ ...context, input: refresh })).rejects.toMatchObject({ code: "PROFORMA_PREVIEW_CHANGED" });
    expect(mocks.persist).not.toHaveBeenCalled();
  });
  it("removes a draft affair without silently waiving its prepayment", async () => {
    const result = await repoRefreshProforma({ ...context, input: refresh });
    expect(result).toMatchObject({ id, status: "DRAFT", row_version: 3 });
    expect(mocks.sources).toHaveBeenCalledWith(mocks.tx, [12,13], true);
    const removal = mocks.tx.query.mock.calls.find(([sql]) => String(sql).includes("requirement='UNCONFIRMED'"));
    expect(removal?.[1]).toEqual([id,[13],expect.any(String),7,"qualification-correlation"]);
    expect(mocks.persist).toHaveBeenCalledWith(mocks.tx, expect.objectContaining({ id, actorId: 7, preview: expect.objectContaining({ preview_hash: hash }) }));
    expect(mocks.tx.query.mock.calls.some(([sql]) => String(sql).includes("requirement='NOT_REQUIRED'"))).toBe(false);
  });
  it("refuses to refresh an issued proforma", async () => {
    mocks.lock.mockResolvedValue({ ...draft, status: "ISSUED" });
    await expect(repoRefreshProforma({ ...context, input: refresh })).rejects.toMatchObject({ code: "PROFORMA_NOT_DRAFT" });
  });
  it("requires BL reconciliation before cancellation", async () => {
    mocks.sources.mockResolvedValue([{ allocation_id: 12, has_active_delivery: true }]);
    await expect(repoCancelProforma({ ...context, input: { expected_version: 2, reason: "Annulation demandée", confirm: true } })).rejects.toMatchObject({ code: "PROFORMA_AFFAIR_DELIVERY_EXISTS" });
    expect(mocks.tx.query).not.toHaveBeenCalled();
  });
  it("returns the active deposit invoices to reconcile, without cancelling them", async () => {
    mocks.tx.query.mockResolvedValueOnce({ rows: [{ facture_id: "123", reference: "ACOMPTE-QUAL" }] });
    await expect(repoCancelProforma({ ...context, input: { expected_version: 2, reason: "Annulation demandée", confirm: true } })).rejects.toMatchObject({ code: "PROFORMA_DEPOSIT_RECONCILIATION_REQUIRED" });
    expect(mocks.tx.query.mock.calls.some(([sql]) => String(sql).includes("UPDATE"))).toBe(false);
  });
  it("requires unreleased receipt evidence to be reconciled even after deposit reversal", async () => {
    mocks.tx.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ id: "receipt" }] });
    await expect(repoCancelProforma({ ...context, input: { expected_version: 2, reason: "Annulation demandée", confirm: true } })).rejects.toMatchObject({ code: "PROFORMA_RECEIPT_RECONCILIATION_REQUIRED" });
  });
  it("cancels an unpaid document while retaining its terms, lines and snapshot", async () => {
    mocks.lock.mockResolvedValue({ ...draft, status: "ISSUED" });
    const result = await repoCancelProforma({ ...context, input: { expected_version: 2, reason: "Annulation demandée", confirm: true } });
    expect(result).toMatchObject({ id, status: "CANCELLED", row_version: 3 });
    expect(mocks.tx.query).toHaveBeenCalledWith(expect.stringContaining("cancellation_reason=$3"), [id,7,"Annulation demandée"]);
    expect(mocks.tx.query.mock.calls.some(([sql]) => String(sql).includes("DELETE") || String(sql).includes("UPDATE public.delivery_affair_prepayment_terms"))).toBe(false);
  });
});
