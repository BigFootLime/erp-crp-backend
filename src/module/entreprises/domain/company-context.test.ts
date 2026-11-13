import { describe, expect, it } from "vitest";

import {
  CompanyContextError,
  assertCommercialProjectionAccess,
  assertCompanyModuleAccess,
  assertCompanyScopedReference,
  assertFixedRuntimeCompany,
  assertLiveMembership,
  resolveActiveCompanyContext,
} from "./company-context";

const CRP = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EC = "22222222-2222-4222-8222-222222222222";
const THIRD = "33333333-3333-4333-8333-333333333333";
const ENTITY = "44444444-4444-4444-8444-444444444444";
const PROFILE = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

function company(overrides: Record<string, unknown> = {}) {
  return {
    id: CRP,
    code: "CRP",
    name: "Croix Rousse Precision",
    status: "ACTIVE",
    profile: "INDUSTRIAL",
    enabled_module_keys: ["clients", "stock", "production", "ged"],
    enabled_commercial_projection_capabilities: [],
    ...overrides,
  };
}

function membership(overrides: Record<string, unknown> = {}) {
  return {
    central_account_id: 42,
    directory_profile_id: PROFILE,
    company_id: CRP,
    status: "ACTIVE",
    enabled_module_keys: ["clients", "stock", "production", "ged"],
    enabled_commercial_projection_capabilities: [],
    ...overrides,
  };
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    central_account_id: 42,
    directory_profile_id: PROFILE,
    requested_company_id: CRP,
    company: company(),
    membership: membership(),
    ...overrides,
  };
}

const crpRuntime = { environment: "cerp_test", company_id: CRP };

function expectCode(fn: () => unknown, code: string) {
  expect(fn).toThrow(CompanyContextError);
  try {
    fn();
  } catch (error) {
    expect((error as CompanyContextError).code).toBe(code);
  }
}

describe("company context", () => {
  it("resolves an industrial company from membership and company module intersection", () => {
    const context = resolveActiveCompanyContext(
      input({
        membership: membership({ enabled_module_keys: ["clients", "stock"] }),
      }),
      crpRuntime,
    );
    expect(context).toMatchObject({
      central_account_id: 42,
      directory_profile_id: PROFILE,
      company_id: CRP,
      environment: "cerp_test",
      workspace: "INDUSTRIAL",
    });
    expect(context.module_keys).toEqual(["clients", "stock"]);
  });

  it("requires an explicit requested company without a fallback", () => {
    const request = input();
    delete (request as { requested_company_id?: unknown }).requested_company_id;
    expectCode(
      () => resolveActiveCompanyContext(request, crpRuntime),
      "COMPANY_CONTEXT_INVALID",
    );
  });

  it("rejects a membership for another company or account", () => {
    expectCode(
      () =>
        resolveActiveCompanyContext(
          input({ membership: membership({ company_id: EC }) }),
          crpRuntime,
        ),
      "COMPANY_MEMBERSHIP_MISMATCH",
    );
    expectCode(
      () =>
        resolveActiveCompanyContext(
          input({ membership: membership({ central_account_id: 77 }) }),
          crpRuntime,
        ),
      "COMPANY_MEMBERSHIP_MISMATCH",
    );
  });

  it("rejects revoked membership and inactive companies", () => {
    expectCode(
      () => assertLiveMembership(membership({ status: "REVOKED" })),
      "COMPANY_MEMBERSHIP_NOT_ACTIVE",
    );
    expectCode(
      () =>
        resolveActiveCompanyContext(
          input({ company: company({ status: "SUSPENDED" }) }),
          crpRuntime,
        ),
      "COMPANY_NOT_ACTIVE",
    );
  });

  it("keeps CERP environment names distinct from company UUIDs and enforces fixed runtime binding", () => {
    expectCode(
      () =>
        assertFixedRuntimeCompany(
          { environment: "cerp_prod", company_id: CRP },
          EC,
        ),
      "FIXED_RUNTIME_COMPANY_MISMATCH",
    );
    expectCode(
      () =>
        assertFixedRuntimeCompany({ environment: CRP, company_id: CRP }, CRP),
      "COMPANY_CONTEXT_INVALID",
    );
    expectCode(
      () =>
        assertFixedRuntimeCompany(
          { environment: "cerp_test", company_id: CRP },
          undefined,
        ),
      "COMPANY_REQUIRED",
    );
  });

  it("keeps a third company isolated at reference level", () => {
    const context = resolveActiveCompanyContext(input(), crpRuntime);
    expect(
      assertCompanyScopedReference(context, { company_id: CRP, id: ENTITY }),
    ).toMatchObject({ id: ENTITY });
    expectCode(
      () =>
        assertCompanyScopedReference(context, {
          company_id: THIRD,
          id: ENTITY,
        }),
      "COMPANY_REFERENCE_MISMATCH",
    );
  });

  it("makes the commercial profile accueil-only and exposes projections separately", () => {
    const commercial = input({
      requested_company_id: EC,
      company: company({
        id: EC,
        code: "EC",
        name: "Esprit Carabine",
        profile: "COMMERCIAL",
        enabled_module_keys: [
          "clients",
          "commandes-clients",
          "commandes-fournisseurs",
          "stock",
          "livraisons",
          "production",
          "ged",
        ],
        enabled_commercial_projection_capabilities: [
          "stock.projection.read",
          "livraisons.projection.read",
        ],
      }),
      membership: membership({
        company_id: EC,
        enabled_module_keys: [
          "clients",
          "commandes-clients",
          "commandes-fournisseurs",
          "stock",
          "livraisons",
          "production",
          "ged",
        ],
        enabled_commercial_projection_capabilities: [
          "stock.projection.read",
          "livraisons.projection.read",
        ],
      }),
    });
    const context = resolveActiveCompanyContext(commercial, {
      environment: "cerp_test",
      company_id: EC,
    });
    expect(context.workspace).toBe("ACCUEIL");
    expect(context.module_keys).toEqual([
      "clients",
      "commandes-clients",
      "commandes-fournisseurs",
    ]);
    expect(context.commercial_projection_capabilities).toEqual([
      "livraisons.projection.read",
      "stock.projection.read",
    ]);
  });

  it("rejects unknown modules and cannot recover access from old role-like inputs", () => {
    expectCode(
      () =>
        resolveActiveCompanyContext(
          input({ company: company({ enabled_module_keys: ["atelier"] }) }),
          crpRuntime,
        ),
      "COMPANY_CONTEXT_INVALID",
    );
    expectCode(
      () =>
        resolveActiveCompanyContext(
          { ...input(), role: "Administrateur Systeme et Reseau" },
          crpRuntime,
        ),
      "COMPANY_CONTEXT_INVALID",
    );
  });

  it("canonicalizes company and Directory profile UUIDs before comparing rights", () => {
    const context = resolveActiveCompanyContext(
      input({
        requested_company_id: CRP.toUpperCase(),
        membership: membership({ directory_profile_id: PROFILE.toUpperCase() }),
      }),
      { environment: "cerp_prod", company_id: CRP.toUpperCase() },
    );
    expect(context.company_id).toBe(CRP);
    expect(context.directory_profile_id).toBe(PROFILE);
    expect(context.environment).toBe("cerp_prod");
  });

  it("does not accept a caller-supplied runtime binding in the access request", () => {
    expectCode(
      () =>
        resolveActiveCompanyContext(
          { ...input(), runtime: crpRuntime },
          crpRuntime,
        ),
      "COMPANY_CONTEXT_INVALID",
    );
    expectCode(
      () =>
        resolveActiveCompanyContext(input(), {
          environment: "cerp_prod",
          company_id: EC,
        }),
      "FIXED_RUNTIME_COMPANY_MISMATCH",
    );
  });

  it("requires known modules from the effective company membership intersection", () => {
    const context = resolveActiveCompanyContext(
      input({ membership: membership({ enabled_module_keys: ["clients"] }) }),
      crpRuntime,
    );
    expect(assertCompanyModuleAccess(context, "clients")).toBe("clients");
    expectCode(
      () => assertCompanyModuleAccess(context, "not-a-module"),
      "COMPANY_MODULE_UNKNOWN",
    );
    expectCode(
      () => assertCompanyModuleAccess(context, "stock"),
      "COMPANY_MODULE_NOT_ALLOWED",
    );
  });

  it("limits stock and delivery projections to the commercial capability scope", () => {
    const commercial = resolveActiveCompanyContext(
      input({
        requested_company_id: EC,
        company: company({
          id: EC,
          code: "EC",
          name: "Esprit Carabine",
          profile: "COMMERCIAL",
          enabled_module_keys: ["clients", "stock"],
          enabled_commercial_projection_capabilities: ["stock.projection.read"],
        }),
        membership: membership({
          company_id: EC,
          enabled_module_keys: ["clients", "stock"],
          enabled_commercial_projection_capabilities: ["stock.projection.read"],
        }),
      }),
      { environment: "cerp_test", company_id: EC },
    );
    expect(
      assertCommercialProjectionAccess(commercial, "stock.projection.read"),
    ).toBe("stock.projection.read");
    expectCode(
      () =>
        assertCommercialProjectionAccess(
          commercial,
          "livraisons.projection.read",
        ),
      "COMMERCIAL_PROJECTION_NOT_ALLOWED",
    );
    expectCode(
      () => assertCommercialProjectionAccess(commercial, "stock.write"),
      "COMMERCIAL_PROJECTION_UNKNOWN",
    );
    expectCode(
      () => assertCompanyModuleAccess(commercial, "stock"),
      "COMPANY_MODULE_NOT_ALLOWED",
    );
    const industrial = resolveActiveCompanyContext(input(), crpRuntime);
    expectCode(
      () =>
        assertCommercialProjectionAccess(industrial, "stock.projection.read"),
      "COMMERCIAL_PROJECTION_SCOPE_DENIED",
    );
  });
});
