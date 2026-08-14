import SwaggerParser from "@apidevtools/swagger-parser";
import { describe, expect, it } from "vitest";

import { GENERATED_ROUTE_INVENTORY } from "../swagger/generated-route-inventory";
import { assertOpenApiRouteSecurity } from "../swagger/openapi-contract";
import { swaggerSpec } from "../swagger/swagger";

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  expect(value).toBeTypeOf("object");
  expect(value).not.toBeNull();
  expect(Array.isArray(value)).toBe(false);
  return value as JsonRecord;
}

function resolveRef(document: JsonRecord, ref: string): unknown {
  expect(ref.startsWith("#/"), ref).toBe(true);
  return ref.slice(2).split("/").reduce<unknown>((value, segment) => record(value)[segment], document);
}

function collectRefs(value: unknown, refs: string[] = []): string[] {
  if (Array.isArray(value)) {
    value.forEach((entry) => collectRefs(entry, refs));
  } else if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value as JsonRecord)) {
      if (key === "$ref" && typeof entry === "string") refs.push(entry);
      else collectRefs(entry, refs);
    }
  }
  return refs;
}

describe("SOL-28 generated OpenAPI contract", () => {
  it("is a valid OpenAPI 3 document", async () => {
    await expect(SwaggerParser.validate(JSON.parse(JSON.stringify(swaggerSpec)))).resolves.toBeDefined();
  });

  it("documents every discovered Express operation exactly once", () => {
    const paths = record(swaggerSpec.paths);
    const documented = GENERATED_ROUTE_INVENTORY.filter((route) => record(paths[route.path])[route.method] !== undefined);
    expect(documented).toHaveLength(GENERATED_ROUTE_INVENTORY.length);
    expect(record(swaggerSpec["x-cerp-route-coverage"])).toMatchObject({
      discovered: GENERATED_ROUTE_INVENTORY.length,
      documented: GENERATED_ROUTE_INVENTORY.length,
      percent: 100,
    });
    expect(new Set(GENERATED_ROUTE_INVENTORY.map((route) => `${route.method} ${route.path}`)).size)
      .toBe(GENERATED_ROUTE_INVENTORY.length);
  });

  it("fails closed for undocumented public routes and secures every other operation", () => {
    expect(() => assertOpenApiRouteSecurity()).not.toThrow();
    const paths = record(swaggerSpec.paths);
    for (const route of GENERATED_ROUTE_INVENTORY) {
      const operation = record(record(paths[route.path])[route.method]);
      const security = operation.security;
      expect(Array.isArray(security), `${route.method} ${route.path}`).toBe(true);
      if (route.authenticated) {
        expect(security, `${route.method} ${route.path}`).toEqual([{ bearerAuth: [] }]);
        expect(operation["x-cerp-rbac"]).toBeTruthy();
      } else {
        expect(operation["x-cerp-public-reason"], `${route.method} ${route.path}`).toBeTypeOf("string");
      }
    }
  });

  it("keeps operation ids unique and every component reference resolvable", () => {
    const paths = record(swaggerSpec.paths);
    const operationIds = GENERATED_ROUTE_INVENTORY.map((route) =>
      String(record(record(paths[route.path])[route.method]).operationId)
    );
    expect(new Set(operationIds).size).toBe(operationIds.length);
    for (const ref of collectRefs(swaggerSpec)) expect(resolveRef(swaggerSpec, ref), ref).toBeDefined();
  });

  it("publishes deployment provenance without exposing secrets", () => {
    const serialized = JSON.stringify(swaggerSpec);
    expect(record(swaggerSpec.info)["x-cerp-source-sha256"]).toMatch(/^[0-9a-f]{64}$/);
    expect(swaggerSpec["x-cerp-contract-digest"]).toMatch(/^[0-9a-f]{64}$/);
    expect(serialized).not.toMatch(/JWT_SECRET|DATABASE_URL|CERP_WEBHOOK_SECRET_ENCRYPTION_KEY|whsec_[A-Za-z0-9_-]{32,}/);
  });
});
