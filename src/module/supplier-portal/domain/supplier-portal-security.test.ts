import { describe, expect, it, vi } from "vitest";
import { supplierPortalPilotEnabled, verifySupplierPortalSession } from "./supplier-portal-security";

describe("supplier portal pilot gate", () => {
  it("is closed by default and rejects a session without exposing the configured secret", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SUPPLIER_PORTAL_PILOT", "1");
    vi.stubEnv("SUPPLIER_PORTAL_PILOT_JWT_SECRET", "x".repeat(32));
    expect(supplierPortalPilotEnabled()).toBe(false);
    try { verifySupplierPortalSession("not-a-token"); throw new Error("expected rejection"); }
    catch (error) { expect(error).toMatchObject({ code: "NOT_FOUND" }); }
    vi.unstubAllEnvs();
  });
});
