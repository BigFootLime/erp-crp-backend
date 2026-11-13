import { describe, expect, it, vi } from "vitest";

const ports = vi.hoisted(() => ({
  audit: vi.fn(async () => null),
  transaction: vi.fn(
    async (client: unknown, fn: (tx: unknown) => Promise<unknown>) =>
      fn(client),
  ),
}));
vi.mock("../../../shared/realtime/realtime-outbox-transaction", () => ({
  withRealtimeOutboxTransaction: ports.transaction,
}));
vi.mock("../../audit-logs/repository/audit-logs.repository", () => ({
  repoInsertAuditLog: ports.audit,
}));
import {
  repoCreateBusinessCompany,
  repoListBusinessCompaniesForProfile,
  repoReadBusinessCompanyContext,
  repoReadBusinessCompanyInstanceBySite,
  repoReadBusinessCompanySiteAdministrativeLevel,
  repoSetBusinessCompanyInstance,
  repoSetBusinessCompanyMembership,
  repoSetBusinessCompanySiteAdministrativeLevel,
  repoUpdateBusinessCompany,
} from "./company-directory.repository";

const company = "11111111-1111-4111-8111-111111111111",
  profile = "22222222-2222-4222-8222-222222222222";
const actor = {
  user_id: 7,
  ip: null,
  user_agent: null,
  device_type: null,
  os: null,
  browser: null,
};
const ownerSession = {
  profile_id: profile,
  source_user_id: 7,
  database: "cerp_prod",
  username: "owner",
  name: "Owner",
  surname: "Directory",
  email: "owner@example.test",
  tel_no: null,
  avatar_key: null,
  avatar_asset_id: null,
  role: "Administrateur Systeme et Reseau",
  roles: ["Administrateur Systeme et Reseau"],
  status: "Active",
  is_superadmin: true,
  mfa_reenrollment_required: false,
  mfa_factor_id: "33333333-3333-4333-8333-333333333333",
  mfa_factor_version: 1,
  mfa_verified_at: new Date().toISOString(),
  mfa_method: "totp",
  global_session_epoch: 1,
  membership_version: 1,
  job_title: null,
  employment_type: null,
  weekly_hours_target: null,
  work_profile_incomplete: false,
  work_profile: null,
  work_profile_start_date: null,
};
const tenantRow = {
  company_id: company,
  profile_id: profile,
  environment: "cerp_prod" as const,
  site_id: "cerp_company_11111111111141118111111111111111_prod",
  is_superadmin: false,
  status: "Active",
  version: 7,
  company_status: "ACTIVE",
  instance_active: true,
  company_membership_status: "ACTIVE",
  user_status: "Active",
  mfa_reenrollment_required: false,
  active_mfa_factor: true,
};
const input = {
  company_id: company,
  code: "EC",
  name: "Esprit Carabine",
  profile: "COMMERCIAL" as const,
  status: "ACTIVE" as const,
  enabled_module_keys: ["clients"],
  enabled_commercial_projection_capabilities: [],
};
function db(rows: unknown[][]) {
  const query = vi.fn(async () => ({ rows: rows.shift() ?? [] }));
  return { connect: vi.fn(async () => ({ query })), query };
}
function expectDirectoryMembershipUpsertToPreserveConfiguredSuperadmin(sql: string) {
  expect(sql).toMatch(/END,false/);
  const conflictUpdate = sql.split("ON CONFLICT(profile_id,database_id) DO UPDATE SET")[1];
  expect(conflictUpdate).toBeDefined();
  expect(conflictUpdate).not.toMatch(/is_superadmin\s*=/);
}
describe("business company directory repository", () => {
  it("creates and audits atomically", async () => {
    const d = db([
      [
        {
          company_id: company,
          code: "EC",
          name: "Esprit Carabine",
          profile: "COMMERCIAL",
          status: "ACTIVE",
          enabled_module_keys: [],
          enabled_commercial_projection_capabilities: [],
          version: 1,
        },
      ],
    ]);
    await repoCreateBusinessCompany(d as any, input, actor);
    expect(d.connect).toHaveBeenCalledOnce();
    expect(ports.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: 7,
        body: expect.objectContaining({ action: "BUSINESS_COMPANY_CREATED" }),
      }),
    );
  });
  it("locks and rejects stale company versions", async () => {
    const d = db([[{ version: 2 }]]);
    await expect(
      repoUpdateBusinessCompany(
        d as any,
        { ...input, expected_version: 1 },
        actor,
      ),
    ).rejects.toThrow("BUSINESS_COMPANY_VERSION_CONFLICT");
    expect(String(d.connect.mock.results[0].value)).toBeTruthy();
  });
  it("rejects stale memberships before upsert", async () => {
    const d = db([[{ version: 2 }]]);
    await expect(
      repoSetBusinessCompanyMembership(
        d as any,
        {
          company_id: company,
          profile_id: profile,
          status: "ACTIVE",
          allowed_module_keys: [],
          denied_module_keys: [],
          enabled_commercial_projection_capabilities: [],
          expected_version: 1,
        },
        actor,
      ),
    ).rejects.toThrow("BUSINESS_COMPANY_MEMBERSHIP_VERSION_CONFLICT");
  });
  it("accepts version zero when creating a membership", async () => {
    const d = db([
      [],
      [],
      [
        {
          profile_id: profile,
          username: "ec-admin",
          name: "Keenan",
          surname: "Martin",
          status: "ACTIVE",
          allowed_module_keys: [],
          denied_module_keys: [],
          enabled_commercial_projection_capabilities: [],
          version: 1,
        },
      ],
    ]);
    await expect(
      repoSetBusinessCompanyMembership(
        d as any,
        {
          company_id: company,
          profile_id: profile,
          status: "ACTIVE",
          allowed_module_keys: [],
          denied_module_keys: [],
          enabled_commercial_projection_capabilities: [],
          expected_version: 0,
        },
        actor,
      ),
    ).resolves.toEqual({
      profile_id: profile,
      username: "ec-admin",
      name: "Keenan",
      surname: "Martin",
      status: "ACTIVE",
      allowed_module_keys: [],
      denied_module_keys: [],
      enabled_commercial_projection_capabilities: [],
      version: 1,
    });
    expect(String((d.query.mock.calls as unknown[][])[2]?.[0])).toContain(
      "SELECT upserted.profile_id,u.username,u.name,u.surname",
    );
    expectDirectoryMembershipUpsertToPreserveConfiguredSuperadmin(
      String((d.query.mock.calls as unknown[][])[3]?.[0]),
    );
  });

  it("preserves an explicitly configured site superadmin while an instance is reactivated", async () => {
    const d = db([
      [], [], [],
      [{
        environment: "cerp_test",
        site_id: "cerp_company_11111111111141118111111111111111_test",
        active: true,
        version: 1,
      }],
    ]);
    await expect(
      repoSetBusinessCompanyInstance(
        d as any,
        {
          company_id: company,
          environment: "cerp_test",
          site_id: "cerp_company_11111111111141118111111111111111_test",
          active: true,
          expected_version: 0,
        },
        actor,
      ),
    ).resolves.toEqual({
      environment: "cerp_test",
      site_id: "cerp_company_11111111111141118111111111111111_test",
      active: true,
      version: 1,
    });
    expectDirectoryMembershipUpsertToPreserveConfiguredSuperadmin(
      String((d.query.mock.calls as unknown[][])[2]?.[0]),
    );
    expect(String((d.query.mock.calls as unknown[][])[2]?.[0])).toContain(
      "SELECT p.profile_id,$2,u.role",
    );
    expect(String((d.query.mock.calls as unknown[][])[2]?.[0])).toContain(
      "AND $3 THEN 'Active' ELSE 'Inactive' END,false",
    );
    expect((d.query.mock.calls as unknown[][])[2]?.[1]).toEqual([
      company,
      "cerp_company_11111111111141118111111111111111_test",
      true,
    ]);
  });
  it("composes only matching company/profile/environment records", async () => {
    const d = db([
      [
        {
          company_id: company,
          profile_id: profile,
          environment: "cerp_test",
          site_id: "cerp_test",
          instance_active: true,
        },
      ],
    ]);
    const found = await repoReadBusinessCompanyContext(d as any, {
      company_id: company,
      profile_id: profile,
      environment: "cerp_test",
    });
    expect(found?.company_id).toBe(company);
    expect((d.query.mock.calls as unknown[][])[0]?.[1]).toEqual([
      company,
      profile,
      "cerp_test",
    ]);
  });

  it("keeps registered instances readable when inactive and version-protects updates", async () => {
    const d = db([
      [
        {
          company_id: company,
          site_id: "cerp_company_11111111111141118111111111111111_test",
          active: false,
        },
      ],
    ]);
    const instance = await repoReadBusinessCompanyInstanceBySite(
      d as any,
      "cerp_company_11111111111141118111111111111111_test",
    );
    expect(instance?.active).toBe(false);
    const stale = db([[{ version: 2 }]]);
    await expect(
      repoSetBusinessCompanyInstance(
        stale as any,
        {
          company_id: company,
          environment: "cerp_test",
          site_id: "cerp_company_11111111111141118111111111111111_test",
          active: true,
          expected_version: 1,
        },
        actor,
      ),
    ).rejects.toThrow("BUSINESS_COMPANY_INSTANCE_VERSION_CONFLICT");
  });

  it("lists a profile only through its requested registered environment", async () => {
    const d = db([
      [
        {
          company_id: company,
          membership_status: "ACTIVE",
          site_id: "cerp_company_11111111111141118111111111111111_test",
        },
      ],
    ]);
    expect(
      await repoListBusinessCompaniesForProfile(d as any, profile, "cerp_test"),
    ).toHaveLength(1);
    expect((d.query.mock.calls as unknown[][])[0]?.[1]).toEqual([
      profile,
      "cerp_test",
    ]);
  });
  it("derives the tenant site, locks the membership, versions the grant and audits it", async () => {
    const d = db([[], [{ ok: 1 }], [tenantRow], [{ ...tenantRow, is_superadmin: true, version: 8 }]]);
    await expect(
      repoSetBusinessCompanySiteAdministrativeLevel(d as any, ownerSession as any, {
        company_id: company,
        profile_id: profile,
        environment: "cerp_prod",
        is_superadmin: true,
        expected_version: 7,
      }),
    ).resolves.toMatchObject({ is_superadmin: true, version: 8, status: "Active" });
    const sql = (d.query.mock.calls as unknown[][]).map((call) => String(call[0])).join("\n");
    expect(sql).toContain("pg_advisory_xact_lock");
    expect(sql).toContain("FOR UPDATE OF c,i,m,dm,u");
    expect(sql).toContain("database_id=$2");
    expect(sql).toContain("owner.database_id='cerp_prod'");
    expect(
      (d.query.mock.calls as unknown[][])
        .map((call) => String(call[0]))
        .find((statement) => statement.startsWith("UPDATE public.cerp_directory_memberships")),
    ).not.toContain("database_id='cerp_prod'");
    expect((d.query.mock.calls as unknown[][])[2]?.[1]).toContain(tenantRow.site_id);
    expect(ports.audit).toHaveBeenCalledWith(expect.objectContaining({
      user_id: 7,
      body: expect.objectContaining({ action: "BUSINESS_COMPANY_SITE_SUPERADMIN_CHANGED" }),
    }));
  });
  it("refuses stale versions and inactive explicit memberships without auditing", async () => {
    const stale = db([[], [{ ok: 1 }], [tenantRow]]);
    await expect(
      repoSetBusinessCompanySiteAdministrativeLevel(stale as any, ownerSession as any, {
        company_id: company, profile_id: profile, environment: "cerp_prod", is_superadmin: true, expected_version: 6,
      }),
    ).rejects.toMatchObject({ code: "BUSINESS_COMPANY_SITE_MEMBERSHIP_STALE" });
    const inactive = db([[{ ...tenantRow, company_membership_status: "REVOKED" }]]);
    await expect(
      repoReadBusinessCompanySiteAdministrativeLevel(inactive as any, { company_id: company, profile_id: profile, environment: "cerp_prod" }),
    ).rejects.toMatchObject({ code: "BUSINESS_COMPANY_SITE_MEMBERSHIP_INACTIVE" });
  });
  it("fails closed when the owner, factor or session epoch is revoked while waiting for the tenant lock", async () => {
    for (const revoked of ["owner", "factor", "epoch"] as const) {
      ports.audit.mockClear();
      const calls: string[] = [];
      const query = vi.fn(async (sql: string) => {
        calls.push(sql);
        if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
        if (sql.includes("FROM public.cerp_directory_memberships source")) return { rows: [] };
        throw new Error(`Unexpected ${revoked} query: ${sql}`);
      });
      const d = { connect: vi.fn(async () => ({ query })), query };
      await expect(
        repoSetBusinessCompanySiteAdministrativeLevel(d as any, ownerSession as any, {
          company_id: company, profile_id: profile, environment: "cerp_prod", is_superadmin: true, expected_version: 7,
        }),
      ).rejects.toMatchObject({ code: "DIRECTORY_OWNER_REAUTH_REQUIRED" });
      expect(calls.some((sql) => sql.startsWith("UPDATE public.cerp_directory_memberships"))).toBe(false);
      expect(ports.audit).not.toHaveBeenCalled();
    }
  });
  it("rechecks MFA freshness after the tenant lock", async () => {
    vi.useFakeTimers();
    const checkedAt = new Date("2026-10-27T20:00:00.000Z");
    vi.setSystemTime(checkedAt);
    const calls: string[] = [];
    const query = vi.fn(async (sql: string) => {
      calls.push(sql);
      if (sql.includes("pg_advisory_xact_lock")) {
        vi.setSystemTime(new Date(checkedAt.getTime() + 300_001));
        return { rows: [] };
      }
      throw new Error(`Unexpected MFA query: ${sql}`);
    });
    const d = { connect: vi.fn(async () => ({ query })), query };
    await expect(
      repoSetBusinessCompanySiteAdministrativeLevel(d as any, { ...ownerSession, mfa_verified_at: checkedAt.toISOString() } as any, {
        company_id: company, profile_id: profile, environment: "cerp_prod", is_superadmin: true, expected_version: 7,
      }),
    ).rejects.toMatchObject({ code: "MFA_STEP_UP_REQUIRED" });
    expect(calls.some((sql) => sql.startsWith("UPDATE public.cerp_directory_memberships"))).toBe(false);
    vi.useRealTimers();
  });
  it("fails closed when MFA expires while waiting on the locked target membership", async () => {
    vi.useFakeTimers();
    const checkedAt = new Date("2026-10-27T20:00:00.000Z");
    vi.setSystemTime(checkedAt);
    const calls: string[] = [];
    const query = vi.fn(async (sql: string) => {
      calls.push(sql);
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (sql.includes("FROM public.cerp_directory_memberships source")) return { rows: [{ ok: 1 }] };
      if (sql.includes("FROM public.cerp_business_companies c")) {
        vi.setSystemTime(new Date(checkedAt.getTime() + 300_001));
        return { rows: [tenantRow] };
      }
      throw new Error(`Unexpected locked-target MFA query: ${sql}`);
    });
    const d = { connect: vi.fn(async () => ({ query })), query };
    await expect(
      repoSetBusinessCompanySiteAdministrativeLevel(d as any, { ...ownerSession, mfa_verified_at: checkedAt.toISOString() } as any, {
        company_id: company, profile_id: profile, environment: "cerp_prod", is_superadmin: true, expected_version: 7,
      }),
    ).rejects.toMatchObject({ code: "MFA_STEP_UP_REQUIRED" });
    expect(calls.some((sql) => sql.startsWith("UPDATE public.cerp_directory_memberships"))).toBe(false);
    expect(ports.audit).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
