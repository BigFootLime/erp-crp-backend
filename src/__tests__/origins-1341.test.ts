import { describe, expect, it } from "vitest";
import { createOriginPolicy } from "../config/origins";
describe("customer origin isolation", () => {
  it("never inherits CRP or development origins on a customer instance", () => {
    const allowed = createOriginPolicy({ CERP_DEPLOYMENT_PROFILE: "customer", CORS_ORIGINS: "https://erp.client.example,app://cerp" });
    expect(allowed("https://erp.client.example")).toBe(true);
    expect(allowed("app://cerp")).toBe(true);
    for (const origin of ["http://erp.client.example", "https://cerp.croix-rousse-precision.fr", "http://localhost:5173", "https://other-client.example", "https://erp.client.example.evil.example"]) expect(allowed(origin)).toBe(false);
  });
  it("preserves existing internal origin configuration", () => {
    const allowed = createOriginPolicy({});
    expect(allowed("http://localhost:5188")).toBe(true);
    expect(allowed("https://cerp.croix-rousse-precision.fr")).toBe(true);
  });
});
