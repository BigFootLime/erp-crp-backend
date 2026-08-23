import { describe, expect, it } from "vitest";

import { GENERATED_ROUTE_INVENTORY } from "../swagger/generated-route-inventory";

type RouteExpectation = Readonly<{
  root: string;
  rbac?: string;
}>;

const aggregates: readonly RouteExpectation[] = [
  { root: "/clients/{id}/creation-snapshot" },
  { root: "/fournisseurs/{id}/creation-snapshot" },
  { root: "/commandes/{id}/creation-snapshot", rbac: "requireAcknowledgementExport" },
  { root: "/production/ofs/{id}/creation-snapshot" },
  { root: "/pieces-techniques/{id}/creation-snapshot" },
  { root: "/affaires/{id}/creation-snapshot", rbac: "requireAffaireCapability(read)" },
  { root: "/stock/articles/{id}/creation-snapshot", rbac: "requireStockCapability(read)" },
];

describe("Wave 2 creation-snapshot route contract", () => {
  it("exposes only the four authenticated, read-only surfaces for every aggregate", () => {
    const allSnapshotRoutes = GENERATED_ROUTE_INVENTORY.filter((route) => route.path.includes("/creation-snapshot"));
    expect(allSnapshotRoutes).toHaveLength(aggregates.length * 4);

    for (const aggregate of aggregates) {
      const expected = [
        ["get", aggregate.root],
        ["get", `${aggregate.root}/{documentId}/preview`],
        ["get", `${aggregate.root}/{documentId}/download`],
        ["post", `${aggregate.root}/{documentId}/print-intents`],
      ] as const;
      const actual = GENERATED_ROUTE_INVENTORY.filter((route) =>
        expected.some(([method, path]) => route.method === method && route.path === path)
      );

      expect(actual).toHaveLength(expected.length);
      for (const route of actual) {
        expect(route.authenticated).toBe(true);
        expect(route.rbac).toContain("moduleAccessGate");
        if (aggregate.rbac) expect(route.rbac).toContain(aggregate.rbac);
      }

      // Creation is queue-driven in the aggregate transaction. A browser may
      // observe it, preview/download its immutable bytes, or record a print intent,
      // but can never create/reissue a snapshot through an HTTP collection POST.
      expect(
        GENERATED_ROUTE_INVENTORY.some(
          (route) => route.method === "post" && route.path === aggregate.root
        )
      ).toBe(false);
    }
  });
});
