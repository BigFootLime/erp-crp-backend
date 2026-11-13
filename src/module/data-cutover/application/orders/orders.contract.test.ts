import { describe, expect, it } from "vitest";
import { buildOrderRemainderDraftsTx } from "./orders.contract";
import type { CutoverRow } from "../../types/data-cutover.types";

const ready = (domain: CutoverRow["domain"], id: string, values: CutoverRow["values"]): CutoverRow => ({
  id, batch_id: "batch", domain, legacy_key: `CLIPPER:${id}`, source_id: "source", sheet: "Orders", row_number: 1,
  source_values: values, values, source_issues: [], source_notes: [], decision: "INCLUDE", review_note: "confirmed", version: 1, status: "READY", issues: [],
});
const resolver = {
  customerId: async (_tx: unknown, code: string) => code === "C-01" ? "customer-1" : null,
  supplierId: async (_tx: unknown, code: string) => code === "F-01" ? "supplier-1" : null,
  articleId: async (_tx: unknown, code: string) => code.startsWith("ART-") ? `article-${code}` : null,
};
const sales = (id: string, reference: string) => ready("SALES_ORDER", id, { customerCode: "C-01", customerOrderNumber: "PO-REAL", orderDate: "2026-10-20", articleReference: reference, quantityRemaining: "2.500", unit: "u", unitPrice: "18.42", vatRate: "20", currency: "EUR", plannedDueDate: "2026-11-02", priceEvidence: "AR-12", orderType: "FERME", orderEvidence: "AR-12", affairNumber: "23907" });

describe("cutover order remainder draft contract", () => {
  it("groups only confirmed customer/PO remainder lines and preserves accepted price evidence", async () => {
    const drafts = await buildOrderRemainderDraftsTx({ tx: {}, resolver, rows: [sales("1", "ART-A"), sales("2", "ART-B")] });
    expect(drafts).toEqual([expect.objectContaining({ kind: "CUSTOMER", customerId: "customer-1", customerOrderNumber: "PO-REAL", lines: [expect.objectContaining({ quantity: "2.500", unitPrice: "18.42", evidenceReference: "AR-12" }), expect.objectContaining({ articleReference: "ART-B" })] })]);
  });
  it("keeps an internal demand separate and refuses a zero/unknown remainder or unresolved target", async () => {
    const internal = ready("INTERNAL_DEMAND", "3", { affairNumber: "INT-7", orderDate: "2026-10-20", articleReference: "ART-A", quantityRemaining: "1", unit: "u", plannedDueDate: "2026-11-04" });
    await expect(buildOrderRemainderDraftsTx({ tx: {}, resolver, rows: [internal] })).resolves.toEqual([expect.objectContaining({ kind: "INTERNAL", historicalReference: "INT-7" })]);
    await expect(buildOrderRemainderDraftsTx({ tx: {}, resolver, rows: [sales("4", "UNKNOWN")] })).rejects.toMatchObject({ code: "CUTOVER_ORDER_ARTICLE_UNRESOLVED" });
    await expect(buildOrderRemainderDraftsTx({ tx: {}, resolver, rows: [ready("SALES_ORDER", "5", { ...sales("5", "ART-A").values, quantityRemaining: "0" })] })).rejects.toMatchObject({ code: "CUTOVER_ORDER_REMAINDER_INVALID" });
    await expect(buildOrderRemainderDraftsTx({ tx: {}, resolver, rows: [ready("SALES_ORDER", "6", { ...sales("6", "ART-A").values, orderType: "UNKNOWN" })] })).rejects.toMatchObject({ code: "CUTOVER_ORDER_CLASSIFICATION_REQUIRED" });
  });
  it("keeps numeric accepted prices and rejects contradictory classifications for one PO", async () => {
    const numeric = ready("SALES_ORDER", "7", { ...sales("7", "ART-A").values, unitPrice: 26.4, vatRate: 20 });
    const other = ready("SALES_ORDER", "8", { ...sales("8", "ART-B").values, orderType: "CADRE_RELEASE", contractTargetId: "11111111-1111-4111-8111-111111111111" });
    await expect(buildOrderRemainderDraftsTx({ tx: {}, resolver, rows: [numeric] })).resolves.toEqual([expect.objectContaining({ lines: [expect.objectContaining({ unitPrice: "26.4", vatRate: "20" })] })]);
    await expect(buildOrderRemainderDraftsTx({ tx: {}, resolver, rows: [sales("7", "ART-A"), other] })).rejects.toMatchObject({ code: "CUTOVER_ORDER_HEADER_CONFLICT" });
  });
});

