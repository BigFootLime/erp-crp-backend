import { describe, expect, it, vi } from "vitest";
vi.mock("./work-profile", () => ({
  directoryWorkProfile: vi.fn(async () => null),
}));
import { createDirectorySessionFromIdentity } from "./session.repository";

const profile = "00000000-0000-4000-8000-000000000001",
  factor = "00000000-0000-4000-8000-000000000002",
  tablet = "00000000-0000-4000-8000-000000000003";
const token = "dir_" + "a".repeat(64),
  verified = "2026-10-26T10:00:00.000Z";
const identity: any = {
  profile_id: profile,
  source_user_id: 7,
  global_session_epoch: 2,
  membership_version: 3,
  mfa_factor_id: factor,
  mfa_factor_version: 4,
  mfa_verified_at: verified,
  mfa_method: "totp",
  tablet_device_id: tablet,
  tablet_pin_version: 5,
};
const validated = {
  profile_id: profile,
  source_user_id: 7,
  database: "cerp_company_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_test",
  username: "alice",
  name: "Alice",
  surname: "A",
  email: "a@example.test",
  tel_no: null,
  avatar_key: null,
  avatar_asset_id: null,
  role: "User",
  roles: ["User"],
  is_superadmin: false,
  status: "Active",
  job_title: null,
  employment_type: null,
  weekly_hours_target: null,
  work_profile_incomplete: false,
  mfa_reenrollment_required: false,
  global_session_epoch: 2,
  membership_version: 9,
  mfa_factor_id: factor,
  mfa_factor_version: 4,
  mfa_verified_at: verified,
  mfa_method: "totp",
  tablet_device_id: tablet,
  tablet_pin_version: 5,
  canonical_is_superadmin: false,
  durable_mfa_required: true,
  canonical_role: "User",
  canonical_roles: ["User"],
  mfa_policy: null,
  has_active_factor: true,
};

describe("createDirectorySessionFromIdentity switch retries", () => {
  it("uses conflict-safe insertion, preserves assurance and validates the existing deterministic session", async () => {
    const calls: { sql: string; args: unknown[] | undefined }[] = [];
    const db = {
      query: vi.fn(async (sql: string, args?: unknown[]) => {
        calls.push({ sql, args });
        if (sql.includes("INSERT INTO public.cerp_directory_sessions"))
          return { rows: [] };
        if (sql.startsWith("SELECT 1 FROM public.cerp_directory_sessions"))
          return { rows: [{ ok: 1 }] };
        if (sql.includes("FROM public.cerp_directory_sessions s"))
          return { rows: [validated] };
        throw new Error("unexpected query");
      }),
    };
    const expiresAt = new Date("2026-10-26T10:15:00.000Z");
    const result = await createDirectorySessionFromIdentity(
      db as any,
      "cerp_company_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_test",
      identity,
      { token, expiresAt },
    );
    expect(result.directory_session).toBe(token);
    expect(result.identity.mfa_verified_at).toBe(verified);
    expect(result.identity.tablet_device_id).toBe(tablet);
    const insert = calls.find((call) =>
      call.sql.includes("INSERT INTO public.cerp_directory_sessions"),
    )!;
    expect(insert.sql).toContain("ON CONFLICT(token_hash) DO NOTHING");
    expect(insert.args?.[10]).toBe(expiresAt.toISOString());
    expect(insert.args?.[11]).toBe(tablet);
    expect(insert.args?.[12]).toBe(5);
    expect(
      calls.some((call) =>
        call.sql.startsWith("SELECT 1 FROM public.cerp_directory_sessions"),
      ),
    ).toBe(true);
  });
});
