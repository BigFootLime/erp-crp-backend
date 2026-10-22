import type { Pool } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DirectorySession } from "./model";
const mocks = vi.hoisted(() => ({ policy: vi.fn(), owner: vi.fn() }));
vi.mock("./common-access", () => ({ readCommonAccessSource: mocks.policy }));
vi.mock("./authority", async original => ({ ...await original<typeof import("./authority")>(), isDirectoryOwner: mocks.owner }));
import { requireDirectoryCompanyConfiguration } from "./company-authorization";
const query = vi.fn(), db = { query } as unknown as Pool, keys = new Map([["cerp_prod", "a".repeat(64)]]);
const actor = () => ({ profile_id: "11111111-1111-4111-8111-111111111111", database: "cerp_test", is_superadmin: false, mfa_factor_id: "factor", mfa_factor_version: 2, mfa_method: "totp", mfa_verified_at: new Date().toISOString() }) as DirectorySession;
beforeEach(() => { mocks.owner.mockResolvedValue(false); query.mockResolvedValue({ rows: [{}] }); mocks.policy.mockReset(); });
describe("shared company delegation", () => {
  it.each(["cerp_test", "cerp_prod"]) ("uses the same current Production account grant from %s", async database => {
    mocks.policy.mockResolvedValue({ modules: [{ module_key: "parametrage-erp", allowed: true }] });
    const identity = { ...actor(), database };
    await requireDirectoryCompanyConfiguration(db, identity, "authority", keys);
    expect(mocks.policy).toHaveBeenCalledWith({ authority_id: "authority", profile_id: identity.profile_id, target_site: database }, keys.get("cerp_prod"), undefined);
  });
  it("rejects a revoked grant and missing current Production membership", async () => {
    mocks.policy.mockResolvedValue({ modules: [{ module_key: "parametrage-erp", allowed: false }] });
    await expect(requireDirectoryCompanyConfiguration(db, actor(), "authority", keys)).rejects.toMatchObject({ status: 403 });
    query.mockResolvedValue({ rows: [] });
    await expect(requireDirectoryCompanyConfiguration(db, actor(), "authority", keys)).rejects.toMatchObject({ status: 403 });
  });
  it("requires recent MFA before reading any common grant", async () => {
    await expect(requireDirectoryCompanyConfiguration(db, { ...actor(), mfa_verified_at: null }, "authority", keys)).rejects.toMatchObject({ status: 428 });
    await expect(requireDirectoryCompanyConfiguration(db, { ...actor(), mfa_verified_at: new Date(Date.now() - 301_000).toISOString() }, "authority", keys)).rejects.toMatchObject({ status: 428 });
    expect(mocks.policy).not.toHaveBeenCalled();
  });
  it("does not authorize using a stale cached grant when the source fails", async () => {
    mocks.policy.mockRejectedValue(Object.assign(new Error("offline"), { status: 503 }));
    await expect(requireDirectoryCompanyConfiguration(db, actor(), "authority", keys)).rejects.toMatchObject({ status: 503 });
  });
});
