import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  accountState: vi.fn(), query: vi.fn(), audit: vi.fn(), bump: vi.fn(), directory: vi.fn(),
}));

vi.mock("../../../config/database", () => ({ default: { query: mocks.query } }));
vi.mock("../../auth/repository/auth.repository", () => ({ findAuthenticatedAccountState: mocks.accountState }));
vi.mock("../../../shared-directory/site-runtime", () => ({ sharedDirectoryClient: mocks.directory }));
vi.mock("../repository/access-control.repository", () => ({ withTransaction: async (work: (tx: unknown) => Promise<unknown>) => work({ query: mocks.query }) }));
vi.mock("../../audit-logs/repository/audit-logs.repository", () => ({ repoInsertAuditLog: mocks.audit }));
vi.mock("../../../shared/realtime/realtime-control-plane", () => ({ bumpRealtimeAuthorizationEpoch: mocks.bump }));

import { setSensitiveCapability } from "./sensitive-capabilities.service";

const input = { params: { userId: 22, capability: "finance.issue" as const }, body: { granted: true, expected_version: 0 } };
const audit = { user_id: 7, ip: null, user_agent: null, device_type: null, os: null, browser: null, path: "/test", client_session_id: null };

describe("sensitive capability grant assurance", () => {
  beforeEach(() => vi.clearAllMocks());
  it("fails closed when the target MFA is revoked after preflight and before the locked write", async () => {
    mocks.directory.mockReturnValue(null);
    mocks.accountState
      .mockResolvedValueOnce({ status: "Active", mfa_factor_id: "11111111-1111-4111-8111-111111111111" })
      .mockResolvedValueOnce(null);
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("FOR SHARE")) return { rows: [{ status: "Active", is_superadmin: true, directory_profile_id: "33333333-3333-4333-8333-333333333333" }] };
      if (sql.includes("FOR UPDATE")) return { rows: [{ status: "Active", is_superadmin: false, directory_profile_id: null }] };
      throw new Error(`unexpected query: ${sql}`);
    });

    await expect(setSensitiveCapability(input, audit)).rejects.toMatchObject({ status: 409, code: "SENSITIVE_ACCESS_MFA_REQUIRED" });
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO public.app_user_sensitive_capabilities"))).toBe(false);
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(mocks.bump).not.toHaveBeenCalled();
  });

  it("uses the canonical directory again after the local target lock instead of a stale projection", async () => {
    mocks.accountState.mockResolvedValue({ status: "Active", mfa_factor_id: "11111111-1111-4111-8111-111111111111" });
    const call = vi.fn()
      .mockResolvedValueOnce({ profile: { status: "Active", is_superadmin: true, mfa_reenrollment_required: false }, mfa_factor_id: "11111111-1111-4111-8111-111111111111" })
      .mockResolvedValueOnce({ profile: { status: "Active", mfa_reenrollment_required: false }, mfa_factor_id: null });
    mocks.directory.mockReturnValue({ call });
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("FOR SHARE")) return { rows: [{ status: "Active", is_superadmin: true, directory_profile_id: "33333333-3333-4333-8333-333333333333" }] };
      if (sql.includes("FOR UPDATE")) return { rows: [{ status: "Active", is_superadmin: false, directory_profile_id: "22222222-2222-4222-8222-222222222222" }] };
      throw new Error(`unexpected query: ${sql}`);
    });

    await expect(setSensitiveCapability(input, audit)).rejects.toMatchObject({ status: 409, code: "SENSITIVE_ACCESS_MFA_REQUIRED" });
    expect(call).toHaveBeenCalledWith("validate-actor", { profile_id: "22222222-2222-4222-8222-222222222222" });
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO public.app_user_sensitive_capabilities"))).toBe(false);
  });

  it("fails closed if the granting actor loses canonical SuperAdmin assurance before the write", async () => {
    mocks.accountState.mockResolvedValue({ status: "Active", mfa_factor_id: "11111111-1111-4111-8111-111111111111" });
    const call = vi.fn().mockResolvedValue({ profile: { status: "Active", is_superadmin: false, mfa_reenrollment_required: false }, mfa_factor_id: "11111111-1111-4111-8111-111111111111" });
    mocks.directory.mockReturnValue({ call });
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("FOR SHARE")) return { rows: [{ status: "Active", is_superadmin: true, directory_profile_id: "33333333-3333-4333-8333-333333333333" }] };
      if (sql.includes("FOR UPDATE")) return { rows: [{ status: "Active", is_superadmin: false, directory_profile_id: null }] };
      throw new Error(`unexpected query: ${sql}`);
    });

    await expect(setSensitiveCapability(input, audit)).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
    expect(call).toHaveBeenCalledWith("validate-actor", { profile_id: "33333333-3333-4333-8333-333333333333" });
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO public.app_user_sensitive_capabilities"))).toBe(false);
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(mocks.bump).not.toHaveBeenCalled();
  });

  it("refuses a local actor without a canonical profile when the directory is enabled", async () => {
    mocks.directory.mockReturnValue({ call: vi.fn() });
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("FOR SHARE")) return { rows: [{ status: "Active", is_superadmin: true, directory_profile_id: null }] };
      if (sql.includes("FOR UPDATE")) return { rows: [{ status: "Active", is_superadmin: false, directory_profile_id: "22222222-2222-4222-8222-222222222222" }] };
      throw new Error(`unexpected query: ${sql}`);
    });

    await expect(setSensitiveCapability(input, audit)).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
    expect(mocks.accountState).not.toHaveBeenCalled();
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO public.app_user_sensitive_capabilities"))).toBe(false);
  });

  it("requires canonical onboarding for a target instead of accepting only local MFA", async () => {
    const call = vi.fn().mockResolvedValue({ profile: { status: "Active", is_superadmin: true, mfa_reenrollment_required: false }, mfa_factor_id: "11111111-1111-4111-8111-111111111111" });
    mocks.directory.mockReturnValue({ call });
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("FOR SHARE")) return { rows: [{ status: "Active", is_superadmin: true, directory_profile_id: "33333333-3333-4333-8333-333333333333" }] };
      if (sql.includes("FOR UPDATE")) return { rows: [{ status: "Active", is_superadmin: false, directory_profile_id: null }] };
      throw new Error(`unexpected query: ${sql}`);
    });

    await expect(setSensitiveCapability(input, audit)).rejects.toMatchObject({ status: 409, code: "SENSITIVE_ACCESS_CANONICAL_PROFILE_REQUIRED" });
    expect(call).toHaveBeenCalledWith("validate-actor", { profile_id: "33333333-3333-4333-8333-333333333333" });
    expect(mocks.accountState).not.toHaveBeenCalled();
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO public.app_user_sensitive_capabilities"))).toBe(false);
  });
});
