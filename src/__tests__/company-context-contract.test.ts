import { describe, expect, it } from "vitest";
import {
  COMPANY_CONTEXT_COMPATIBILITY_FIXTURES,
  COMPANY_CONTEXT_HTTP_HEADERS,
} from "../module/entreprises/contract/company-context-contract-v1";
import { buildOpenApiDocument } from "../swagger/openapi-contract";
import {
  createCompanyRuntimeService,
} from "../module/entreprises/runtime/company-runtime.service";

describe("public company-context v1 contract", () => {
  it("documents the canonical headers without changing discovery or exchange requirements", () => {
    type Operation = { parameters: Array<{ name: string; in: string; required: boolean }> };
    const paths = buildOpenApiDocument().paths as Record<string, { get: Operation; post: Operation }>;
    const names = Object.values(COMPANY_CONTEXT_HTTP_HEADERS);
    const headers = (operation: Operation) => operation.parameters
      .filter((parameter) => parameter.in === "header" && names.includes(parameter.name as typeof names[number]))
      .map(({ name, required }) => ({ name, required }));
    expect(headers(paths["/entreprises/sign-in-context"].get)).toEqual(names.map((name) => ({ name, required: false })));
    expect(headers(paths["/entreprises/context"].get)).toEqual(names.map((name) => ({ name, required: false })));
    expect(headers(paths["/entreprises/switches/exchange"].post)).toEqual(names.map((name) => ({ name, required: true })));
  });
  it("builds the legacy response through the production response builder", async () => {
    const service = createCompanyRuntimeService({
      env: () => ({}), directory: () => null, site: () => "cerp_prod",
      accessProfile: async () => null,
    });
    await expect(service.view({ id: 7 })).resolves.toEqual(
      COMPANY_CONTEXT_COMPATIBILITY_FIXTURES.legacy,
    );
  });

  it("builds an industrial response through the production Directory/runtime seam", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const profileId = "33333333-3333-4333-8333-333333333333";
    const service = createCompanyRuntimeService({
      env: () => ({ CERP_BUSINESS_COMPANIES_ENABLED: "true", CERP_COMPANY_ID: id, CERP_COMPANY_ENVIRONMENT: "cerp_prod", CERP_SHARED_DIRECTORY_ENABLED: "true" }),
      site: () => "cerp_company_fixture_prod",
      directory: () => ({ call: async (operation: string) => operation === "business-company-context" ? ({
        company: { ...COMPANY_CONTEXT_COMPATIBILITY_FIXTURES.industrial.active_company, status: "ACTIVE", enabled_module_keys: ["production"], enabled_commercial_projection_capabilities: [] },
        membership: { central_account_id: 1, directory_profile_id: profileId, company_id: id, status: "ACTIVE", allowed_module_keys: ["production"], denied_module_keys: [], enabled_commercial_projection_capabilities: [] },
        instance: { company_id: id, environment: "cerp_prod", site_id: "cerp_company_fixture_prod", active: true },
      }) : ({ environment: "cerp_prod", companies: [COMPANY_CONTEXT_COMPATIBILITY_FIXTURES.industrial.active_company] }) }) as never,
      accessProfile: async () => ({ is_superadmin: false, modules: [{ module_key: "production", label: "Production", nav_page_keys: [], allowed: true, source: "ROLE" }] }) as never,
    });
    const view = await service.view({ id: 1, directory_session: "session", directory_profile_id: profileId });
    expect(view).toEqual(COMPANY_CONTEXT_COMPATIBILITY_FIXTURES.industrial);
  });

  it("builds the commercial fixture through the production Directory/runtime seam", async () => {
    const id = "22222222-2222-4222-8222-222222222222";
    const profileId = "33333333-3333-4333-8333-333333333333";
    const service = createCompanyRuntimeService({
      env: () => ({ CERP_BUSINESS_COMPANIES_ENABLED: "true", CERP_COMPANY_ID: id, CERP_COMPANY_ENVIRONMENT: "cerp_test", CERP_SHARED_DIRECTORY_ENABLED: "true" }),
      site: () => "cerp_company_fixture_test",
      directory: () => ({ call: async (operation: string) => operation === "business-company-context" ? ({
        company: { ...COMPANY_CONTEXT_COMPATIBILITY_FIXTURES.commercial.active_company, status: "ACTIVE", enabled_module_keys: ["clients"], enabled_commercial_projection_capabilities: ["stock.projection.read"] },
        membership: { central_account_id: 1, directory_profile_id: profileId, company_id: id, status: "ACTIVE", allowed_module_keys: ["clients"], denied_module_keys: [], enabled_commercial_projection_capabilities: ["stock.projection.read"] },
        instance: { company_id: id, environment: "cerp_test", site_id: "cerp_company_fixture_test", active: true },
      }) : ({ environment: "cerp_test", companies: [COMPANY_CONTEXT_COMPATIBILITY_FIXTURES.commercial.active_company] }) }) as never,
      accessProfile: async () => ({ is_superadmin: false, modules: [{ module_key: "clients", label: "Clients", nav_page_keys: [], allowed: true, source: "ROLE" }] }) as never,
    });
    const view = await service.view({ id: 1, directory_session: "session", directory_profile_id: profileId });
    expect(view).toEqual(COMPANY_CONTEXT_COMPATIBILITY_FIXTURES.commercial);
  });

  it("preserves Directory duplicate list rows rather than changing the runtime response", async () => {
    const id = "22222222-2222-4222-8222-222222222222";
    const profileId = "33333333-3333-4333-8333-333333333333";
    const company = COMPANY_CONTEXT_COMPATIBILITY_FIXTURES.commercial.active_company;
    const service = createCompanyRuntimeService({
      env: () => ({ CERP_BUSINESS_COMPANIES_ENABLED: "true", CERP_COMPANY_ID: id, CERP_COMPANY_ENVIRONMENT: "cerp_test", CERP_SHARED_DIRECTORY_ENABLED: "true" }), site: () => "cerp_company_fixture_test",
      directory: () => ({ call: async (operation: string) => operation === "business-company-context" ? ({ company: { ...company, status: "ACTIVE", enabled_module_keys: ["clients"], enabled_commercial_projection_capabilities: ["stock.projection.read"] }, membership: { central_account_id: 1, directory_profile_id: profileId, company_id: id, status: "ACTIVE", allowed_module_keys: ["clients"], denied_module_keys: [], enabled_commercial_projection_capabilities: ["stock.projection.read"] }, instance: { company_id: id, environment: "cerp_test", site_id: "cerp_company_fixture_test", active: true } }) : ({ environment: "cerp_test", companies: [company, company] }) }) as never,
      accessProfile: async () => ({ is_superadmin: false, modules: [{ module_key: "clients", label: "Clients", nav_page_keys: [], allowed: true, source: "ROLE" }] }) as never,
    });
    await expect(service.view({ id: 1, directory_session: "session", directory_profile_id: profileId })).resolves.toMatchObject({ available_companies: [company, company] });
  });
});
