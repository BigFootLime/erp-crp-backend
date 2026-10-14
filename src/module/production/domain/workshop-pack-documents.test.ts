import { describe, expect, it } from "vitest";
import { workshopFrozenPlans } from "./workshop-pack-documents";
const plan = { id: "11111111-1111-4111-8111-111111111111", version_id: "22222222-2222-4222-8222-222222222222", sha256: "a".repeat(64), role: "PLAN_CLIENT" };
describe("manufacturing folder frozen plan provenance", () => {
  it("retains the exact frozen version and hash, with client plan first", () => {
    expect(workshopFrozenPlans({ documents: [{ ...plan, role: "PLAN_FABRICATION" }, plan, plan] })).toEqual([plan, { ...plan, role: "PLAN_FABRICATION" }]);
  });
  it("never infers a plan from an unversioned or incomplete attachment", () => {
    expect(() => workshopFrozenPlans({ documents: [{ ...plan, version_id: null }] })).toThrow();
    expect(() => workshopFrozenPlans({ documents: [{ ...plan, sha256: null }] })).toThrow();
    expect(workshopFrozenPlans({ documents: [{ id: plan.id, role: "PROGRAMME_CN" }] })).toEqual([]);
  });
  it("keeps a missing plan missing instead of inventing a reference", () => {
    expect(workshopFrozenPlans(null)).toEqual([]); expect(workshopFrozenPlans({})).toEqual([]);
  });
  it("retains existing role aliases without changing the original authorization link", () => {
    expect(workshopFrozenPlans({ documents: [{ ...plan, role: "TECHNICAL_DRAWING" }] })).toEqual([{ ...plan, source_role: "TECHNICAL_DRAWING" }]);
    expect(workshopFrozenPlans({ documents: [{ ...plan, role: "MANUFACTURING_DRAWING" }] })).toEqual([{ ...plan, role: "PLAN_FABRICATION", source_role: "MANUFACTURING_DRAWING" }]);
  });
});
