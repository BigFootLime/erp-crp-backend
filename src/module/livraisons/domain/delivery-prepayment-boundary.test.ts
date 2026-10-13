import { describe, expect, it } from "vitest";
import { proformaLineFunding } from "../../facturation/domain/proforma-funding";
import { deliveryContractBoundary } from "./delivery-contract-boundary";
import { deliveryPrepaymentBoundary, type DeliveryPrepaymentSource } from "./delivery-prepayment-boundary";

const coverage = (amount = "100.00") => proformaLineFunding({ billedClientId: "COMPANY-A", currency: "EUR", requiredAmount: "100.00", issuedCreditsAmount: "0.00", receipts: [
  { id: "RECEIPT-A", paymentAllocationId: "PAYMENT-ALLOC-A", billedClientId: "COMPANY-A", currency: "EUR", amount,
    releasedAmount: "0.00", paymentStatus: "ALLOCATED", paymentWorkflowStatus: "ALLOCATED", reversalOfId: null, depositDocumentStatus: "ISSUED" },
] });
const affair = (overrides: Partial<DeliveryPrepaymentSource> = {}): DeliveryPrepaymentSource => ({
  allocationId: 1, requirement: "PROFORMA", proformaId: "PF-A", documentStatus: "ISSUED", sourceUnchanged: true,
  billingParts: [coverage()], ...overrides,
});
const check = (sources: DeliveryPrepaymentSource[], hasUnboundLines = false) => deliveryPrepaymentBoundary({ sources, hasUnboundLines });

describe("BL scope and paid proformas", () => {
  it("groups paid affairs belonging to exactly one proforma", () => {
    expect(check([affair(), affair({ allocationId: 2 })])).toEqual({ groupKey: "PROFORMA:pf-a", blockers: [] });
  });
  it("groups only affairs explicitly outside proforma", () => {
    expect(check([affair({ requirement: "NOT_REQUIRED", proformaId: null, documentStatus: null, billingParts: [] })])).toEqual({ groupKey: "NONE", blockers: [] });
  });
  it("refuses different paid proformas", () => {
    expect(check([affair(), affair({ allocationId: 2, proformaId: "PF-B" })]).blockers.map(x => x.code)).toContain("MIXED_DELIVERY_PROFORMA");
  });
  it("refuses with/without proforma in the same BL", () => {
    expect(check([affair(), affair({ allocationId: 2, requirement: "NOT_REQUIRED", proformaId: null, documentStatus: null, billingParts: [] })]).blockers.map(x => x.code)).toContain("MIXED_DELIVERY_PROFORMA");
  });
  it("does not approve historical unknown terms", () => {
    expect(check([affair({ requirement: "UNCONFIRMED", proformaId: null, documentStatus: null, billingParts: [] })]).blockers[0]?.code).toBe("DELIVERY_PREPAYMENT_UNCONFIRMED");
  });
  it("one company paid and one partly paid cannot ship even if combined money looks sufficient", () => {
    expect(check([affair({ billingParts: [coverage(), coverage("50.00")] })]).blockers.map(x => x.code)).toContain("DELIVERY_PROFORMA_NOT_PAID");
  });
  it.each(["DRAFT", "CANCELLED"] as const)("refuses a %s proforma", documentStatus => {
    expect(check([affair({ documentStatus })]).blockers.map(x => x.code)).toContain("DELIVERY_PROFORMA_NOT_ISSUED");
  });
  it("requires each billed company's receipt evidence", () => {
    expect(check([affair({ billingParts: [] })]).blockers.map(x => x.code)).toContain("DELIVERY_PROFORMA_NOT_PAID");
  });
  it("requires a proforma identity when prepayment is required", () => {
    expect(check([affair({ proformaId: null })]).blockers.map(x => x.code)).toContain("DELIVERY_PROFORMA_REQUIRED");
  });
  it("requires revalidation after quantities/terms change", () => {
    expect(check([affair({ sourceUnchanged: false })]).blockers.map(x => x.code)).toContain("DELIVERY_PROFORMA_SOURCE_CHANGED");
  });
  it("a paid proforma cannot remove the independent contract restriction", () => {
    expect(check([affair(), affair({ allocationId: 2 })]).blockers).toEqual([]);
    expect(deliveryContractBoundary({ clientId: "PHYSICAL-CUSTOMER", hasUnboundLines: false, orders: [
      { commande_id: "1", client_id: "PHYSICAL-CUSTOMER", contract_id: "CONTRACT-A", order_type: "CADRE" },
      { commande_id: "2", client_id: "PHYSICAL-CUSTOMER", contract_id: "CONTRACT-B", order_type: "CADRE" },
    ] }).blocker?.code).toBe("MIXED_DELIVERY_CONTRACT");
  });
  it("never treats an unbound historical BL line as outside proforma", () => {
    expect(check([], true).blockers[0]?.code).toBe("DELIVERY_PREPAYMENT_LINE_SOURCE_REQUIRED");
  });
  it("fails closed on contradictory terms or duplicate source evidence", () => {
    expect(check([affair({ requirement: "NOT_REQUIRED" })]).blockers[0]?.code).toBe("DELIVERY_PREPAYMENT_BINDING_INCONSISTENT");
    expect(check([affair(), affair()]).blockers[0]?.code).toBe("DELIVERY_PREPAYMENT_SOURCE_DUPLICATED");
  });
});
