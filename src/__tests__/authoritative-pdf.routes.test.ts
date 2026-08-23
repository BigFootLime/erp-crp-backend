import { describe, expect, it } from "vitest";

import { GENERATED_ROUTE_INVENTORY } from "../swagger/generated-route-inventory";

type ExpectedRoute = readonly [method: string, path: string];

function expectAuthoritativeRouteSet(expected: readonly ExpectedRoute[], capability: string): void {
  const actual = GENERATED_ROUTE_INVENTORY.filter((route) =>
    expected.some(([method, path]) => route.method === method && route.path === path)
  );
  expect(actual).toHaveLength(expected.length);
  for (const route of actual) {
    expect(route.authenticated).toBe(true);
    expect(route.rbac).toContain("moduleAccessGate");
    expect(route.rbac).toContain(capability);
  }
}

describe("authoritative PDF route contract (#612)", () => {
  it("keeps supplier purchase-order PDFs behind explicit export capability", () => {
    const root = "/commandes-fournisseurs/{id}/official-documents";
    expectAuthoritativeRouteSet([
      ["get", root], ["post", root], ["get", `${root}/{documentId}`],
      ["get", `${root}/{documentId}/preview`], ["get", `${root}/{documentId}/download`],
      ["post", `${root}/{documentId}/print-intents`],
    ], "requireCapability(export)");
  });

  it("keeps customer quote PDFs behind explicit export capability", () => {
    const root = "/devis/{id}/official-documents";
    expectAuthoritativeRouteSet([
      ["get", root], ["post", root], ["get", `${root}/{documentId}`],
      ["get", `${root}/{documentId}/preview`], ["get", `${root}/{documentId}/download`],
      ["post", `${root}/{documentId}/print-intents`],
    ], "requireCapability(export)");
  });

  it("keeps customer acknowledgements entity-scoped, including exact-byte send", () => {
    const root = "/commandes/{id}/acknowledgements";
    expectAuthoritativeRouteSet([
      ["get", root], ["post", root], ["get", `${root}/{documentId}`],
      ["get", `${root}/{documentId}/preview`], ["get", `${root}/{documentId}/download`],
      ["post", `${root}/{documentId}/print-intents`], ["post", `${root}/{documentId}/send`],
    ], "requireAcknowledgementExport");
  });
});
