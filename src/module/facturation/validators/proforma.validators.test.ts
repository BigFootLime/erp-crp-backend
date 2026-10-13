import { describe, expect, it } from "vitest";
import { deliveryPrepaymentTermsBodySchema, proformaDraftBodySchema, proformaIssueBodySchema, proformaReceiptAssignmentBodySchema } from "./proforma.validators";

const draft = { client_id: "CUSTOMER-A", affairs: [{ allocation_id: 12, billing_parts: [{ billed_client_id: "COMPANY-A", quantity: "100" }] }] };
const assignment = { payment_allocation_id: "10000000-0000-4000-8000-000000000001", assignments: [{
  proforma_billing_part_id: "10000000-0000-4000-8000-000000000002", deposit_source_id: "10000000-0000-4000-8000-000000000003", amount: "100.00",
}] };

describe("proforma API input boundaries", () => {
  it("normalizes selected identifiers and currency", () => {
    expect(proformaDraftBodySchema.parse({ ...draft, client_id: " CUSTOMER-A ", currency: " eur " })).toMatchObject({ client_id: "CUSTOMER-A", currency: "EUR" });
  });
  it.each(["paid", "price", "status", "total_ttc", "source_snapshot"])("never accepts a caller's authoritative %s", key => {
    expect(proformaDraftBodySchema.safeParse({ ...draft, [key]: true }).success).toBe(false);
  });
  it("rejects per-line price overrides", () => {
    expect(proformaDraftBodySchema.safeParse({ ...draft, affairs: [{ ...draft.affairs[0], unit_price_ex_tax: "0.01" }] }).success).toBe(false);
  });
  it.each(["0", "-1", "1.0001", "1 000", "1,2", "1e2"])("refuses ambiguous or invalid quantities %s", quantity => {
    expect(proformaDraftBodySchema.safeParse({ ...draft, affairs: [{ allocation_id: 12, billing_parts: [{ billed_client_id: "COMPANY-A", quantity }] }] }).success).toBe(false);
  });
  it("rejects duplicated affairs and company entries", () => {
    expect(proformaDraftBodySchema.safeParse({ ...draft, affairs: [draft.affairs[0], draft.affairs[0]] }).success).toBe(false);
    expect(proformaDraftBodySchema.safeParse({ ...draft, affairs: [{ allocation_id: 12, billing_parts: [draft.affairs[0]!.billing_parts[0], draft.affairs[0]!.billing_parts[0]] }] }).success).toBe(false);
  });
  it("requires explicit confirmed issuance and source version", () => {
    expect(proformaIssueBodySchema.safeParse({ expected_version: 1, preview_hash: "a".repeat(64), confirm: true }).success).toBe(true);
    expect(proformaIssueBodySchema.safeParse({ expected_version: 1, preview_hash: "a".repeat(64) }).success).toBe(false);
  });
  it("requires an existing payment allocation rather than an invented paid flag", () => {
    expect(proformaReceiptAssignmentBodySchema.parse(assignment)).toEqual(assignment);
    expect(proformaReceiptAssignmentBodySchema.safeParse({ ...assignment, paid: true }).success).toBe(false);
  });
  it("rejects duplicated receipt targets and excess cent precision", () => {
    expect(proformaReceiptAssignmentBodySchema.safeParse({ ...assignment, assignments: [assignment.assignments[0], assignment.assignments[0]] }).success).toBe(false);
    expect(proformaReceiptAssignmentBodySchema.safeParse({ ...assignment, assignments: [{ ...assignment.assignments[0], amount: "100.001" }] }).success).toBe(false);
  });
  it("historical terms require an explicit, reasoned decision", () => {
    expect(deliveryPrepaymentTermsBodySchema.safeParse({ expected_version: 1, requirement: "NOT_REQUIRED", reason: "Conditions client vérifiées", confirm: true }).success).toBe(true);
    expect(deliveryPrepaymentTermsBodySchema.safeParse({ expected_version: 1, requirement: "NOT_REQUIRED" }).success).toBe(false);
    expect(deliveryPrepaymentTermsBodySchema.safeParse({ expected_version: 1, requirement: "UNCONFIRMED", reason: "RAS", confirm: true }).success).toBe(false);
  });
});
