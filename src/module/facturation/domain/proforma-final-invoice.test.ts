import { describe, expect, it } from "vitest";
import { planProformaFinalInvoice, type FinalInvoiceAffair } from "./proforma-final-invoice";

const affair = (overrides: Partial<FinalInvoiceAffair> = {}): FinalInvoiceAffair => ({
  allocation_id: "10", delivered_quantity: "12.000", quantity_already_selected: "0.000", requirement: "PROFORMA",
  proforma_id: "proforma", proforma_reference: "PF-2026-001", proforma_status: "ISSUED", currency: "EUR",
  billing_part_id: "part-a", billed_client_id: "company-a", billed_client_name: "Société A", billed_client_blocked: false,
  part_quantity: "30.000", part_already_selected: "0.000", unit_price_ex_tax: "40.0000", discount_percent: "0.0000",
  global_discount_percent: "5.0000", tax_rate_percent: "20.0000", source_revision: "frozen", ...overrides,
});
const plan = (affairs: FinalInvoiceAffair[], quantity = "12.000", sourceQuantity = "12.000", remainingSourceQuantity = sourceQuantity) =>
  planProformaFinalInvoice({ affairs, quantity, sourceQuantity, remainingSourceQuantity, billedClientId: "company-a", currency: "EUR" });

describe("#1268 final invoice company quotas", () => {
  it("retains the legacy physical-party rule for a delivery outside proforma", () => {
    expect(plan([affair({ requirement: "NOT_REQUIRED" })])).toBeNull();
  });
  it("attributes a partial BL to an explicit company quota without fractional prorating", () => {
    expect(plan([affair()])).toMatchObject({ capacity: "12.000", unit_price_ex_tax: "40.0000", global_discount_percent: "5.0000",
      contributions: [{ billing_part_id: "part-a", allocation_id: "10", quantity: "12.000" }] });
  });
  it("counts earlier invoices and drafts against the same company across later BLs", () => {
    const source = affair({ delivered_quantity: "50.000", part_already_selected: "12.000" });
    expect(plan([source], "18.000", "50.000")).toMatchObject({ capacity: "18.000" });
    expect(() => plan([source], "18.001", "50.000")).toThrow(expect.objectContaining({ code: "PROFORMA_FINAL_QUANTITY_EXCEEDED" }));
  });
  it("keeps the actual delivered budget distinct from the company quota", () => {
    expect(() => plan([affair({ quantity_already_selected: "11.000" })], "2.000", "12.000", "1.000"))
      .toThrow(expect.objectContaining({ code: "PROFORMA_FINAL_QUANTITY_EXCEEDED" }));
  });
  it("fills known affairs deterministically and preserves every contribution", () => {
    const sources = [affair({ allocation_id: "20", billing_part_id: "part-b", delivered_quantity: "10.000" }),
      affair({ delivered_quantity: "10.000", quantity_already_selected: "7.000" })];
    const before = structuredClone(sources);
    expect(plan(sources, "8.000", "20.000", "13.000")?.contributions).toEqual([
      { billing_part_id: "part-a", allocation_id: "10", quantity: "3.000" },
      { billing_part_id: "part-b", allocation_id: "20", quantity: "5.000" },
    ]);
    expect(sources).toEqual(before);
  });
  it("refuses an unapproved company even when it is the delivery recipient", () => {
    expect(() => plan([affair({ billed_client_id: "physical-client", billing_part_id: null })]))
      .toThrow(expect.objectContaining({ code: "SOURCE_CLIENT_MISMATCH" }));
  });
  it.each([
    { requirement: "NOT_REQUIRED", allocation_id: "20" },
    { proforma_status: "CANCELLED", allocation_id: "20" },
    { proforma_id: "other", allocation_id: "20" },
    { currency: "USD", allocation_id: "20" },
  ])("refuses a mixed or invalid proforma source %j", changed => {
    expect(() => plan([affair(), affair(changed)], "1.000", "24.000"))
      .toThrow(expect.objectContaining({ code: "PROFORMA_FINAL_SOURCE_SCOPE_INVALID" }));
  });
  it("does not multiply one affair's quota by the number of its physical lots", () => {
    expect(() => plan([affair(), affair()], "1.000", "24.000"))
      .toThrow(expect.objectContaining({ code: "PROFORMA_FINAL_PHYSICAL_SOURCE_INVALID" }));
  });
  it("refuses missing physical lineage and a blocked billed company", () => {
    expect(() => plan([affair()], "1.000", "15.000")).toThrow(expect.objectContaining({ code: "PROFORMA_FINAL_PHYSICAL_SOURCE_INVALID" }));
    expect(() => plan([affair({ billed_client_blocked: true })])).toThrow(expect.objectContaining({ code: "CLIENT_BLOCKED" }));
  });
  it("does not silently apply one price to affairs with different frozen terms", () => {
    expect(() => plan([affair({ delivered_quantity: "5.000" }), affair({ allocation_id: "20", delivered_quantity: "7.000", unit_price_ex_tax: "41.0000" })]))
      .toThrow(expect.objectContaining({ code: "PROFORMA_FINAL_PRICING_MIXED" }));
  });
  it("exposes an exhausted quota for the source picker without fabricating a positive selection", () => {
    const result=planProformaFinalInvoice({affairs:[affair({part_already_selected:"30.000"})],
      sourceQuantity:"12.000",remainingSourceQuantity:"12.000",billedClientId:"company-a",currency:"EUR"});
    expect(result).toMatchObject({capacity:"0.000",contributions:[],unit_price_ex_tax:"40.0000"});
  });
});
