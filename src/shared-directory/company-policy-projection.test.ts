import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
const ports = vi.hoisted(() => ({
  catalog: vi.fn(),
  upsert: vi.fn(),
  audit: vi.fn(),
}));
vi.mock("../shared/realtime/realtime-outbox-transaction", () => ({
  withRealtimeOutboxTransaction: async (client: any, work: any) => work(client),
}));
vi.mock(
  "../module/access-control/repository/access-control.repository",
  () => ({
    repoListCatalogModules: ports.catalog,
    repoUpsertUserModuleAccess: ports.upsert,
  }),
);
vi.mock("../module/audit-logs/repository/audit-logs.repository", () => ({
  repoInsertAuditLog: ports.audit,
}));
import { synchronizeCompanyPolicy } from "./company-policy-projection";

const authority = "00000000-0000-4000-8000-000000000001",
  profile = "00000000-0000-4000-8000-000000000002",
  company = "00000000-0000-4000-8000-000000000003",
  other = "00000000-0000-4000-8000-000000000004";
function policy(overrides: Record<string, unknown> = {}) {
  const body = {
    authority_id: authority,
    profile_id: profile,
    company_id: company,
    environment: "cerp_test",
    target_site: "cerp_company_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_test",
    company_version: 1,
    membership_version: 1,
    instance_version: 1,
    modules: ["clients"],
    ...overrides,
  };
  return {
    ...body,
    policy_hash: createHash("sha256")
      .update(JSON.stringify(body))
      .digest("hex"),
    request_nonce: randomUUID(),
    issued_at: Math.floor(Date.now() / 1000),
  };
}
describe("company policy projection fixed runtime scope", () => {
  it("grants explicit ordinary modules while removing protected and disabled grants without granting sensitive rights", async () => {
    vi.clearAllMocks();
    ports.catalog.mockResolvedValue([
      { module_key: "clients", is_active: true, is_protected: false },
      { module_key: "stock", is_active: true, is_protected: false },
      { module_key: "administration", is_active: true, is_protected: true },
      { module_key: "devis", is_active: false, is_protected: false },
    ]);
    const value = policy({ modules: ["clients", "administration", "devis"] });
    const q = vi.fn(async (sql: string) => {
      if (sql.includes("FROM public.users")) return { rows: [{ id: 7 }] };
      if (sql.includes("FROM public.cerp_company_policy_projections"))
        return { rows: [] };
      if (sql.includes("FROM public.app_module_user_access"))
        return {
          rows: [
            { module_key: "stock", access: "GRANTED" },
            { module_key: "administration", access: "GRANTED" },
          ],
        };
      return { rows: [] };
    });
    const tx = { query: q };
    await synchronizeCompanyPolicy(
      { connect: vi.fn(async () => tx) } as any,
      { businessCompanyPolicy: vi.fn(async () => value) } as any,
      {
        session: "dir_" + "a".repeat(64),
        profileId: profile,
        userId: 7,
        site: value.target_site,
        authorityId: authority,
        expectedCompanyId: company,
        expectedEnvironment: "cerp_test",
      },
    );
    expect(
      ports.upsert.mock.calls.map(([, input]) => [
        input.moduleKey,
        input.access,
      ]),
    ).toEqual([
      ["clients", "GRANTED"],
      ["stock", "DENIED"],
      ["administration", "DENIED"],
      ["devis", "DENIED"],
    ]);
    expect(ports.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        tx,
        user_id: 7,
        body: expect.objectContaining({
          action: "DIRECTORY_COMPANY_POLICY_PROJECTED",
        }),
      }),
    );
    expect(
      q.mock.calls.some(
        ([sql]) =>
          sql.includes("app_user_sensitive_capabilities") ||
          sql.includes("is_superadmin"),
      ),
    ).toBe(false);
  });
  it.each([
    ["another company", policy({ company_id: other })],
    ["another environment", policy({ environment: "cerp_prod" })],
  ])(
    "rejects %s before opening a local ACL transaction",
    async (_label, value) => {
      const connect = vi.fn(async () => {
        throw new Error("must not connect");
      });
      await expect(
        synchronizeCompanyPolicy(
          { connect } as any,
          { businessCompanyPolicy: vi.fn(async () => value) } as any,
          {
            session: "dir_" + "a".repeat(64),
            profileId: profile,
            userId: 7,
            site: "cerp_company_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_test",
            authorityId: authority,
            expectedCompanyId: company,
            expectedEnvironment: "cerp_test",
          },
        ),
      ).rejects.toMatchObject({ code: "COMPANY_POLICY_UNAVAILABLE" });
      expect(connect).not.toHaveBeenCalled();
    },
  );
  it("rejects a changed policy with unchanged authority revisions before granting", async () => {
    // The equality/hash branch is covered by a DB-shaped prior snapshot; ACL
    // catalogue queries must never be reached.
    const value = policy();
    const q = vi.fn(async (sql: string) => {
      if (sql.includes("pg_advisory")) return { rows: [] };
      if (sql.includes("FROM public.users")) return { rows: [{ id: 7 }] };
      if (sql.includes("cerp_company_policy_projections"))
        return {
          rows: [
            {
              company_version: 1,
              membership_version: 1,
              instance_version: 1,
              policy_hash: "f".repeat(64),
            },
          ],
        };
      throw new Error("ACL query must not run");
    });
    const release = vi.fn();
    await expect(
      synchronizeCompanyPolicy(
        { connect: vi.fn(async () => ({ query: q, release })) } as any,
        { businessCompanyPolicy: vi.fn(async () => value) } as any,
        {
          session: "dir_" + "a".repeat(64),
          profileId: profile,
          userId: 7,
          site: value.target_site,
          authorityId: authority,
          expectedCompanyId: company,
          expectedEnvironment: "cerp_test",
        },
      ),
    ).rejects.toMatchObject({ code: "COMPANY_POLICY_UNAVAILABLE" });
    expect(q).not.toHaveBeenCalledWith(
      expect.stringContaining("app_modules"),
      expect.anything(),
    );
  });
});
