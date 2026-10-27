import { describe, expect, it, vi } from "vitest";
import { readSwitchState } from "./business-company-switch.repository";

const base = {
  company_id: "00000000-0000-4000-8000-000000000010",
  code: "ACME",
  name: "Acme",
  profile: "COMMERCIAL",
  enabled_module_keys: [],
  company_projection_capabilities: [],
  denied_module_keys: [],
  membership_projection_capabilities: [],
  environment: "cerp_test",
  site_id: "cerp_company_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_test",
  company_membership_version: 4,
  source_company_membership_version: 5,
  target_directory_membership_version: 6,
  source_membership_version: 7,
  global_session_epoch: "8",
  source_session_expires_at: new Date(Date.now() + 60_000).toISOString(),
  profile_id: "00000000-0000-4000-8000-000000000001",
  source_user_id: 1,
  mfa_factor_id: null,
  mfa_factor_version: null,
  mfa_verified_at: null,
  mfa_method: null,
  tablet_device_id: null,
  tablet_pin_version: null,
};
describe("readSwitchState", () => {
  it("uses contiguous PostgreSQL parameters and normalizes pg bigint epochs", async () => {
    const query = vi.fn(async () => ({ rows: [base] }));
    const state = await readSwitchState({ query } as any, {
      profileId: base.profile_id,
      companyId: base.company_id,
      environment: "cerp_test",
      sourceSessionHash: "a".repeat(64),
      sourceSite: base.site_id,
    });
    const [sql, args] = (
      query.mock.calls as unknown as [string, unknown[]][]
    )[0];
    expect(sql).toContain("s.token_hash=$4");
    expect(sql).toContain("s.database_id=$5");
    expect(args).toHaveLength(5);
    expect(state?.global_session_epoch).toBe(8);
  });
  it("rejects an unsafe bigint epoch instead of comparing a pg string", async () => {
    const query = vi.fn(async () => ({
      rows: [{ ...base, global_session_epoch: "9007199254740992" }],
    }));
    await expect(
      readSwitchState({ query } as any, {
        profileId: base.profile_id,
        companyId: base.company_id,
        environment: "cerp_test",
      }),
    ).rejects.toThrow("DIRECTORY_SESSION_REJECTED");
  });
  it("keeps the context-only query valid without a source-session alias", async () => {
    const query = vi.fn(async () => ({
      rows: [{ ...base, source_session_expires_at: null }],
    }));
    await readSwitchState({ query } as any, {
      profileId: base.profile_id,
      companyId: base.company_id,
      environment: "cerp_test",
    });
    const [sql, args] = (
      query.mock.calls as unknown as [string, unknown[]][]
    )[0];
    expect(sql).toContain("source_company_membership ON false");
    expect(sql).not.toContain("$4");
    expect(args).toHaveLength(3);
  });
});
