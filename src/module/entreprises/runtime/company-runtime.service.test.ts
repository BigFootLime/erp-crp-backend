import { describe, it, expect, vi } from "vitest";
import { companyRuntimeConfiguration } from "./company-runtime.config";
import { createCompanyRuntimeService } from "./company-runtime.service";

const companyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const otherCompany = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const profileId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const site = "cerp_company_aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa_test";
const actor = {
  id: 42,
  directory_profile_id: profileId,
  directory_session: `dir_${"a".repeat(64)}`,
};
const env = () => ({
  CERP_BUSINESS_COMPANIES_ENABLED: "true",
  CERP_COMPANY_ID: companyId,
  CERP_COMPANY_ENVIRONMENT: "cerp_test",
  CERP_SHARED_DIRECTORY_ENABLED: "true",
});
function snapshot() {
  return {
    company: {
      id: companyId,
      code: "COMMERCIAL",
      name: "Commercial fixture",
      status: "ACTIVE",
      profile: "COMMERCIAL",
      enabled_module_keys: ["clients", "stock", "production", "facturation"],
      enabled_commercial_projection_capabilities: ["stock.projection.read"],
    },
    membership: {
      central_account_id: 7,
      directory_profile_id: profileId,
      company_id: companyId,
      status: "ACTIVE",
      allowed_module_keys: ["clients", "facturation"],
      denied_module_keys: ["facturation"],
      enabled_commercial_projection_capabilities: ["stock.projection.read"],
    },
    instance: {
      company_id: companyId,
      environment: "cerp_test",
      site_id: site,
      active: true,
    },
  };
}
function setup(
  override: {
    env?: NodeJS.ProcessEnv;
    snapshot?: unknown;
    call?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const call =
    override.call ??
    vi.fn(async (operation: string) =>
      operation === "business-company-context"
        ? (override.snapshot ?? snapshot())
        : {
            environment: "cerp_test",
            companies: [
              {
                id: companyId,
                code: "COMMERCIAL",
                name: "Commercial fixture",
                profile: "COMMERCIAL",
              },
            ],
          },
    );
  const accessProfile = vi.fn(async () => ({
    is_superadmin: true,
    modules: ["clients", "stock", "production", "facturation"].map(
      (module_key) => ({
        module_key,
        label: module_key,
        nav_page_keys: [module_key],
        allowed: true,
        source: "SUPERADMIN" as const,
      }),
    ),
  }));
  const service = createCompanyRuntimeService({
    env: () => override.env ?? env(),
    directory: () => ({ call }) as never,
    site: () => site,
    accessProfile,
  });
  return { service, call, accessProfile };
}

describe("fixed company runtime configuration", () => {
  it("keeps legacy explicitly disabled and rejects half-configured company mode", () => {
    expect(companyRuntimeConfiguration({})).toEqual({ enabled: false });
    for (const bad of [
      { CERP_BUSINESS_COMPANIES_ENABLED: "TRUE" },
      { ...env(), CERP_COMPANY_ID: undefined },
      { ...env(), CERP_SHARED_DIRECTORY_ENABLED: "false" },
    ])
      expect(() => companyRuntimeConfiguration(bad)).toThrow();
  });
});

describe("live company runtime access", () => {
  it("intersects local ACL, explicit company policy and company-specific denials", async () => {
    const { service } = setup();
    const result = await service.access(actor);
    expect(result?.context.module_keys).toEqual(["clients"]);
    expect(result?.context.workspace).toBe("ACCUEIL");
    expect(result?.context.commercial_projection_capabilities).toEqual([
      "stock.projection.read",
    ]);
    expect(result?.context.central_account_id).toBe(7);
  });
  it("defaults an active membership to no modules and does not grant later company additions", async () => {
    const empty = snapshot();
    empty.membership.allowed_module_keys = [];
    const { service } = setup({ snapshot: empty });
    expect((await service.access(actor))?.context.module_keys).toEqual([]);
    const explicit = snapshot();
    explicit.company.enabled_module_keys.push("reporting-commercial");
    const { service: onlyClients } = setup({ snapshot: explicit });
    expect((await onlyClients.access(actor))?.context.module_keys).toEqual([
      "clients",
    ]);
  });
  it("never treats an empty or failed authority reply as legacy access", async () => {
    for (const response of [
      null,
      {},
      {
        ...snapshot(),
        instance: { ...snapshot().instance, company_id: otherCompany },
      },
      {
        ...snapshot(),
        instance: { ...snapshot().instance, environment: "cerp_prod" },
      },
    ]) {
      const { service } = setup({ call: vi.fn(async () => response) });
      await expect(service.access(actor)).rejects.toMatchObject({
        status: 503,
      });
    }
  });
  it("does not reuse membership for a different central profile", async () => {
    const { service } = setup();
    await expect(
      service.access({ ...actor, directory_profile_id: otherCompany }),
    ).rejects.toMatchObject({ status: 403 });
  });
  it("revalidates company access on every request and preserves a genuine denial", async () => {
    const { service, call } = setup();
    await service.access(actor);
    call.mockRejectedValueOnce(
      Object.assign(new Error("private error"), {
        status: 403,
        code: "BUSINESS_COMPANY_ACCESS_DENIED",
      }),
    );
    await expect(service.access(actor)).rejects.toMatchObject({
      status: 403,
      code: "COMPANY_ACCESS_DENIED",
    });
    expect(call).toHaveBeenCalledTimes(2);
  });
  it("returns only a minimal company list in the current environment", async () => {
    const { service } = setup();
    const result = await service.view(actor);
    expect(result.mode).toBe("COMPANY");
    expect(JSON.stringify(result)).not.toContain(site);
    expect(JSON.stringify(result)).not.toContain("directory_session");
    expect(result.module_keys).toEqual(["clients"]);
  });
  it("keeps legacy context free of companies without contacting Directory", async () => {
    const { service, call } = setup({ env: {} });
    expect((await service.view({ id: 42 })).mode).toBe("LEGACY");
    expect(call).not.toHaveBeenCalled();
  });
  it("requires a Directory session before company data can be returned", async () => {
    const { service } = setup();
    await expect(service.view({ id: 42 })).rejects.toMatchObject({
      status: 401,
    });
  });
});
