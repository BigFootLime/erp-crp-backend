import { describe, expect, it } from "vitest";
import { ordinaryAccountInput, privateAccountPatchSchema } from "../module/admin/domain/private-account-data";
describe("account provisioning does not collect or erase private HR attributes", () => {
  it("keeps ordinary fields and drops empty legacy HR placeholders", () => {
    expect(ordinaryAccountInput({ name: "Fixture", social_security_number: null, salary: null, national_id: "", date_of_birth: null })).toEqual({ name: "Fixture" });
  });
  it("refuses private data on the ordinary account endpoint, including a zero salary", () => {
    for (const body of [{ salary: 0 }, { social_security_number: "123456789012345" }, { date_of_birth: "2000-01-01" }, { national_id: "fixture-only" }]) expect(() => ordinaryAccountInput(body)).toThrow(expect.objectContaining({ code: "PRIVATE_PROFILE_SEPARATE" }));
  });
  it("strictly limits the private-profile patch and preserves omitted values", () => {
    expect(privateAccountPatchSchema.parse({ salary: 0 })).toEqual({ salary: 0 });
    for (const body of [{}, { role: "Directeur" }, { is_superadmin: true }, { date_of_birth: "2999-01-01" }, { salary: -1 }]) expect(privateAccountPatchSchema.safeParse(body).success).toBe(false);
  });
});
