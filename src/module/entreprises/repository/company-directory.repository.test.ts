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
  repoSetBusinessCompanyInstance,
  repoSetBusinessCompanyMembership,
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
          company_id: company,
          profile_id: profile,
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
    ).resolves.toMatchObject({ version: 1 });
    expectDirectoryMembershipUpsertToPreserveConfiguredSuperadmin(
      String((d.query.mock.calls as unknown[][])[3]?.[0]),
    );
  });

  it("preserves an explicitly configured site superadmin while an instance is reactivated", async () => {
    const d = db([
      [], [], [],
      [{
        company_id: company,
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
    ).resolves.toMatchObject({ version: 1 });
    expectDirectoryMembershipUpsertToPreserveConfiguredSuperadmin(
      String((d.query.mock.calls as unknown[][])[2]?.[0]),
    );
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
});
