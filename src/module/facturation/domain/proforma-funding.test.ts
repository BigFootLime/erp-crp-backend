import { describe, expect, it } from "vitest";
import { assertProformaReceiptBudget, proformaLineFunding, type ProformaReceiptEvidence } from "./proforma-funding";

const receipt = (overrides: Partial<ProformaReceiptEvidence> = {}): ProformaReceiptEvidence => ({
  id: "RECEIPT-A", paymentAllocationId: "PAYMENT-ALLOCATION-A", billedClientId: "COMPANY-A",
  currency: "EUR", amount: "100.00", releasedAmount: "0.00", paymentStatus: "ALLOCATED",
  paymentWorkflowStatus: "ALLOCATED", reversalOfId: null, depositDocumentStatus: "ISSUED", ...overrides,
});
const funding = (receipts: ProformaReceiptEvidence[], requiredAmount = "100.00") => proformaLineFunding({
  billedClientId: "COMPANY-A", currency: "EUR", requiredAmount, issuedCreditsAmount: "0.00", receipts,
});

describe("proforma paid affairs — real receipt evidence", () => {
  it("covers an affair with several receipts using exact cents", () => {
    expect(funding([receipt({ amount: "33.33" }), receipt({ id: "B", amount: "66.67" })])).toMatchObject({
      status: "PAID", paidAmount: "100.00", remainingAmount: "0.00", blockers: [],
    });
  });
  it("keeps the affair unpaid without allocated receipts", () => {
    expect(funding([])).toMatchObject({ status: "UNPAID", remainingAmount: "100.00" });
  });
  it("blocks partial receipt coverage, even one cent short", () => {
    expect(funding([receipt({ amount: "99.99" })])).toMatchObject({ status: "PARTIALLY_PAID", remainingAmount: "0.01" });
  });
  it.each([
    { paymentStatus: "REVERSED" }, { paymentStatus: "REJECTED" },
    { paymentWorkflowStatus: "REVERSED" }, { reversalOfId: 99 },
  ])("removes reversed/rejected evidence %j", overrides => {
    expect(funding([receipt(overrides)])).toMatchObject({ status: "UNPAID", paidAmount: "0.00" });
  });
  it("does not treat a deposit invoice draft as fiscal receipt evidence", () => {
    expect(funding([receipt({ depositDocumentStatus: "DRAFT" })]).status).toBe("UNPAID");
  });
  it("an explicit release removes coverage without deleting its receipt", () => {
    expect(funding([receipt({ releasedAmount: "20.00" })])).toMatchObject({ status: "PARTIALLY_PAID", paidAmount: "80.00" });
  });
  it.each([{ billedClientId: "COMPANY-B" }, { currency: "USD" }])("does not borrow money from another party or currency %j", overrides => {
    expect(funding([receipt(overrides)])).toMatchObject({ status: "INVALID", paidAmount: "0.00" });
  });
  it("does not trust a historical paid label", () => {
    expect(funding([receipt({ paymentStatus: "payee" })]).status).toBe("INVALID");
  });
  it("refuses duplicate evidence rather than counting the same receipt twice", () => {
    expect(() => funding([receipt(), receipt()])).toThrow("Une affectation de règlement apparaît plusieurs fois");
  });
  it.each([{ releasedAmount: "100.01" }, { amount: "0.00" }, { releasedAmount: "-0.01" }])("rejects corrupt receipt amounts %j", overrides => {
    expect(funding([receipt(overrides)]).status).toBe("INVALID");
  });
  it("refuses an over-allocated line", () => {
    expect(funding([receipt({ amount: "100.01" })]).status).toBe("INVALID");
  });
  it("permits a genuine free line; issuance is independently required by the delivery boundary", () => {
    expect(funding([], "0.00").status).toBe("PAID");
  });
  it("refuses negative required amounts", () => {
    expect(() => funding([], "-1.00")).toThrow("Le montant à payer ne peut pas être négatif");
  });
  it("deducts an issued deposit credit once, across several partial receipts", () => {
    expect(proformaLineFunding({ billedClientId: "COMPANY-A", currency: "EUR", requiredAmount: "100.00",
      issuedCreditsAmount: "20.00", receipts: [receipt({ amount: "40.00" }), receipt({ id: "B", amount: "60.00" })] }))
      .toMatchObject({ paidAmount: "80.00", remainingAmount: "20.00", status: "PARTIALLY_PAID" });
  });
  it("a credit note never substitutes for received money", () => {
    expect(proformaLineFunding({ billedClientId: "COMPANY-A", currency: "EUR", requiredAmount: "100.00",
      issuedCreditsAmount: "100.00", receipts: [] })).toMatchObject({ paidAmount: "0.00", status: "UNPAID" });
  });
});

describe("one payment allocation shared between proforma affairs", () => {
  it("allows only the unused cents of a receipt", () => {
    expect(() => assertProformaReceiptBudget({ allocatedAmount: "100.00", usedAmount: "60.00", requestedAmount: "40.00" })).not.toThrow();
    expect(() => assertProformaReceiptBudget({ allocatedAmount: "100.00", usedAmount: "60.00", requestedAmount: "40.01" })).toThrow("déjà affecté à d'autres affaires");
  });
  it.each([{ allocatedAmount: "100.00", usedAmount: "100.01", requestedAmount: "1.00" },
    { allocatedAmount: "100.00", usedAmount: "0.00", requestedAmount: "0.00" }])("fails closed on invalid availability %j", args => {
    expect(() => assertProformaReceiptBudget(args)).toThrow("doit être vérifiée");
  });
});
