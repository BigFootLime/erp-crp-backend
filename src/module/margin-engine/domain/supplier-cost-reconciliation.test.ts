import { describe, expect, it } from "vitest";
import { reconcileSupplierCostSources, type SupplierReceiptCost, type SupplierInvoiceCost } from "./supplier-cost-reconciliation";

const receipt = (patch: Partial<SupplierReceiptCost> = {}): SupplierReceiptCost => ({
  key: "receipt:1", category: "SUBCONTRACTING", amount_ht: "1200", source_type: "SUPPLIER_RECEPTION_ACTUAL",
  source_ref: "receipt-1", observed_at: "2026-10-01", source_reliability: "DECLARED", currency: "EUR",
  order_line_id: "order-line", receipt_quantity: "100", purchase_unit: "u", ...patch,
});
const invoice = (patch: Partial<SupplierInvoiceCost> = {}): SupplierInvoiceCost => ({
  key: "invoice-line:1", category: "SUBCONTRACTING", amount_ht: "440", source_type: "SUPPLIER_INVOICE_APPROVED_LINE",
  source_ref: "invoice-line-1", observed_at: "2026-10-02", source_reliability: "VERIFIED", currency: "EUR",
  order_line_id: "order-line", invoice_id: "invoice-1", document_type: "INVOICE", invoiced_quantity: "40",
  invoice_unit: "pce", purchase_unit: "u", purchase_currency: "EUR", supplier_matches: true,
  receipt_links_valid: true, archive_ready: true, header_allocated: true, ...patch,
});

// Prepared, not executed before the final combined acceptance requested.
describe("supplier cost attribution without invoice/receipt double counting", () => {
  it("uses the approved invoice plus only the unbilled receipt proportion", () => {
    const costs = reconcileSupplierCostSources([receipt()], [invoice()]);
    expect(costs.map(cost => cost.amount_ht)).toEqual(["440", "720.000000"]);
    expect(costs.map(cost => cost.source_reliability)).toEqual(["VERIFIED", "DECLARED"]);
    expect(costs[0].source_document_ref).toBe("invoice-1");
  });
  it("replaces the entire receipt estimate when fully invoiced and adds signed credit amounts", () => {
    const costs = reconcileSupplierCostSources([receipt()], [invoice({ invoiced_quantity: "100", amount_ht: "1100" }),
      invoice({ key: "credit-line", document_type: "CREDIT_NOTE", amount_ht: "-100", invoiced_quantity: "10" })]);
    expect(costs.map(cost => cost.amount_ht)).toEqual(["1100", "-100"]);
  });
  it("retains a declared receipt estimate while an invoice is not approved", () => {
    const receipts = [receipt()];
    expect(reconcileSupplierCostSources(receipts, [])).toEqual(receipts);
  });
  it.each(["C62", "H87"])("recognises the documented count unit %s without converting quantities", unit => {
    expect(reconcileSupplierCostSources([receipt()], [invoice({ invoice_unit: unit })])[0].amount_ht).toBe("440");
  });
  it.each([
    { supplier_matches: false }, { receipt_links_valid: false }, { archive_ready: false },
    { header_allocated: false }, { currency: "USD" }, { invoice_unit: "kg" },
    { invoice_unit: null }, { invoiced_quantity: null }, { invoiced_quantity: "0" },
    { invoiced_quantity: "110" }, { amount_ht: "-1" }, { amount_ht: "NaN" }, { invoiced_quantity: "NaN" },
  ])("keeps an allocation exception rather than a guessed total: %j", patch => {
    const costs = reconcileSupplierCostSources([receipt()], [invoice(patch)]);
    expect(costs).toHaveLength(1);
    expect(costs[0].amount_ht).toBeNull();
    expect(costs[0].source_reliability).toBe("UNKNOWN");
    expect(costs[0].definition).toBeTruthy();
  });
  it("detects cumulative overbilling across invoices", () => {
    const costs = reconcileSupplierCostSources([receipt()], [invoice({ invoiced_quantity: "60" }),
      invoice({ key: "invoice-line:2", invoiced_quantity: "60" })]);
    expect(costs[0].amount_ht).toBeNull();
    expect(costs[0].definition).toContain("cumulée");
  });
  it("does not lose a missing price on the unbilled remainder", () => {
    expect(reconcileSupplierCostSources([receipt({ amount_ht: null })], [invoice()]).map(cost => cost.amount_ht)).toEqual(["440", null]);
  });
  it("explains unallocated transport on the unbilled remainder without discarding the approved invoice", () => {
    const costs = reconcileSupplierCostSources([receipt({ amount_ht: null, source_reliability: "UNKNOWN",
      definition: "Transport de commande non réparti entre lignes : coût à confirmer." })], [invoice()]);
    expect(costs.map(cost => cost.amount_ht)).toEqual(["440", null]);
    expect(costs.map(cost => cost.source_reliability)).toEqual(["VERIFIED", "UNKNOWN"]);
    expect(costs[1].definition).toContain("Transport de commande non réparti");
  });
  it("lets a fully approved and allocated invoice establish cost despite an unresolved order estimate", () => {
    const costs = reconcileSupplierCostSources([receipt({ amount_ht: null, source_reliability: "UNKNOWN" })],
      [invoice({ invoiced_quantity: "100", amount_ht: "1250" })]);
    expect(costs).toHaveLength(1);
    expect(costs[0].amount_ht).toBe("1250");
    expect(costs[0].source_reliability).toBe("VERIFIED");
  });
  it("returns a data exception for an invalid physical quantity", () => {
    expect(reconcileSupplierCostSources([receipt({ receipt_quantity: "NaN" })], [invoice()])[0].source_reliability).toBe("UNKNOWN");
  });
  it("combines partial receipts before prorating without rounding each receipt", () => {
    const costs = reconcileSupplierCostSources([receipt({ receipt_quantity: "30", amount_ht: "360" }),
      receipt({ key: "receipt:2", receipt_quantity: "70", amount_ht: "840" })], [invoice()]);
    expect(costs.map(cost => cost.amount_ht)).toEqual(["440", "720.000000"]);
  });
});
