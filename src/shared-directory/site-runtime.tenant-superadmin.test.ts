import { describe, expect, it } from "vitest";
import { tenantProjectionIdentity } from "./site-runtime";

const identity = {
  profile_id: "11111111-1111-4111-8111-111111111111",
  is_superadmin: true,
} as any;

describe("tenant Directory superadmin projection", () => {
  it("does not infer a tenant grant from unrelated CRP state", () => {
    expect(
      tenantProjectionIdentity(
        { ...identity, is_superadmin: false },
        "cerp_company_22222222222242228222222222222222_prod",
      ).is_superadmin,
    ).toBe(false);
  });
  it("projects only the explicit current tenant grant and reflects revocation", () => {
    const site = "cerp_company_22222222222242228222222222222222_prod";
    expect(tenantProjectionIdentity(identity, site).is_superadmin).toBe(true);
    expect(tenantProjectionIdentity({ ...identity, is_superadmin: false }, site).is_superadmin).toBe(false);
  });
});
