import { describe, expect, it } from "vitest";
import { ACTIVE_SUBCONTRACT_ORDER_STATES, isSubcontractPackageEligible } from "./subcontract-package-policy";

const sent = {status:"SENT",type:"SOUS_TRAITANCE",statut_ligne:"ACTIVE",order_status:"RECUE"};

describe("subcontract package after complete receipt", () => {
  it("allows closure after receipt but refuses further custody and cancellation", () => {
    expect(isSubcontractPackageEligible(sent,"CLOSE")).toBe(true);
    expect(isSubcontractPackageEligible(sent)).toBe(false);
    expect(ACTIVE_SUBCONTRACT_ORDER_STATES).not.toContain("RECUE");
  });
  it.each(ACTIVE_SUBCONTRACT_ORDER_STATES)("preserves existing active order state %s", order_status => {
    expect(isSubcontractPackageEligible({...sent,order_status})).toBe(true);
    expect(isSubcontractPackageEligible({...sent,order_status},"CLOSE")).toBe(true);
  });
  it.each([{status:"CLOSED"},{status:"CANCELLED"},{type:"MATIERE"},{statut_ligne:"ANNULEE"},{order_status:"ANNULEE"},{order_status:"BROUILLON"}])("refuses an ineligible package %j even during closure", changed => {
    expect(isSubcontractPackageEligible({...sent,...changed},"CLOSE")).toBe(false);
  });
  it("refuses a missing package", () => expect(isSubcontractPackageEligible(undefined,"CLOSE")).toBe(false));
});
