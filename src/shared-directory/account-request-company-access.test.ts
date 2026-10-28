import { describe, expect, it } from "vitest";
import { deriveApprovedCompanyAccess } from "./account-request-company-access";

const company = {
  company_id: "11111111-1111-4111-8111-111111111111", code: "EC", name: "Esprit Carabine",
  profile: "COMMERCIAL" as const, status: "ACTIVE", membership_version: 0,
  enabled_module_keys: ["clients", "facturation", "production"],
  enabled_commercial_projection_capabilities: ["stock.projection.read"],
};
describe("deriveApprovedCompanyAccess", () => {
  it("uses the reviewed decision and commercial ceiling, never a second ACL payload", () => {
    expect(deriveApprovedCompanyAccess(["clients", "production", "facturation"], [{ company_id: company.company_id, expected_membership_version: 0 }], [company]))
      .toMatchObject([{ allowed_module_keys: ["clients", "facturation"], enabled_commercial_projection_capabilities: ["stock.projection.read"] }]);
  });
  it("fails closed for an inactive company or a stale membership version", () => {
    expect(() => deriveApprovedCompanyAccess(["clients"], [{ company_id: company.company_id, expected_membership_version: 1 }], [company])).toThrow("rattachement entreprise");
    expect(() => deriveApprovedCompanyAccess(["clients"], [{ company_id: company.company_id, expected_membership_version: 0 }], [{ ...company, status: "SUSPENDED" }])).toThrow("pas disponible");
  });
});
