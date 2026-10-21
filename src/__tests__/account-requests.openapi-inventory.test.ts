import { describe, expect, it } from "vitest";

import { GENERATED_ROUTE_INVENTORY } from "../swagger/generated-route-inventory";
import { swaggerSpec } from "../swagger/swagger";
import { ASSIGNABLE_USER_ROLES, PRIMARY_USER_ROLES } from "../module/auth/domain/roles";

describe("account request OpenAPI inventory", () => {
  it("documents the full simultaneous selection and the distinct primary-function catalogue", () => {
    const schemas = swaggerSpec.components!.schemas as Record<string, { properties: Record<string, Record<string, unknown>> }>;
    expect(schemas.AccountRequestApproval.properties.primary_role).toMatchObject({ enum: [...PRIMARY_USER_ROLES] });
    expect(schemas.AccountRequestApproval.properties.roles).toMatchObject({
      minItems: 1,
      maxItems: ASSIGNABLE_USER_ROLES.length,
      items: { enum: [...ASSIGNABLE_USER_ROLES] },
    });
  });

  it("discovers the two public and four SuperAdmin request routes through named router imports", () => {
    const routes = GENERATED_ROUTE_INVENTORY.filter((route) => route.path.includes("account-requests"));

    expect(routes.map((route) => `${route.method} ${route.path}`).sort()).toEqual([
      "delete /admin/account-requests/{id}",
      "get /admin/account-requests",
      "get /auth/account-requests/status",
      "post /admin/account-requests/{id}/approve",
      "post /admin/account-requests/{id}/reject",
      "post /auth/account-requests",
    ]);

    const publicRoutes = routes.filter((route) => route.path.startsWith("/auth/"));
    expect(publicRoutes).toHaveLength(2);
    for (const route of publicRoutes) {
      expect(route.authenticated).toBe(false);
      expect(route.rbac).toEqual([]);
    }

    const adminRoutes = routes.filter((route) => route.path.startsWith("/admin/"));
    expect(adminRoutes).toHaveLength(4);
    for (const route of adminRoutes) {
      expect(route.authenticated).toBe(true);
      expect(route.rbac).toEqual(expect.arrayContaining([
        "moduleAccessGate",
        "requireSuperadmin",
        "requireRecentMfaForMutations",
      ]));
    }
  });

  it("documents the public receipt contract without making the SuperAdmin routes public", () => {
    const paths = swaggerSpec.paths as Record<string, Record<string, Record<string, unknown>>>;
    const submit = paths["/auth/account-requests"].post;
    const status = paths["/auth/account-requests/status"].get;
    const approve = paths["/admin/account-requests/{id}/approve"].post;

    expect(submit.security).toEqual([]);
    expect(submit["x-cerp-public-reason"]).toBeTypeOf("string");
    expect(status.security).toEqual([]);
    expect(status["x-cerp-public-reason"]).toBeTypeOf("string");
    expect(status.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Authorization", in: "header", required: true }),
      expect.objectContaining({ name: "X-CERP-Database", in: "header", required: true }),
    ]));

    expect(approve.security).toEqual([{ bearerAuth: [] }]);
    expect(approve["x-cerp-rbac"]).toEqual(expect.arrayContaining(["requireSuperadmin", "requireRecentMfaForMutations"]));

    const schemas = swaggerSpec.components!.schemas as Record<string, { properties: Record<string, Record<string, unknown>> }>;
    expect(schemas.AccountRequestSubmit.properties.password).toMatchObject({ minLength: 10, writeOnly: true });
    expect(schemas.AccountRequestReceipt.properties.receipt.readOnly).toBe(true);
    expect(schemas.AccountRequestReceipt.properties.receipt.writeOnly).toBeUndefined();
  });
});
