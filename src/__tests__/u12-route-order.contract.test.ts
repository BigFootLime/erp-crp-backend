import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = fs.readFileSync(path.resolve(process.cwd(), "src/routes/v1.routes.ts"), "utf8");
const productionSource = fs.readFileSync(
  path.resolve(process.cwd(), "src/module/production/routes/production.routes.ts"),
  "utf8",
);
const qualitySource = fs.readFileSync(
  path.resolve(process.cwd(), "src/module/qualite/routes/qualite.routes.ts"),
  "utf8",
);

function position(fragment: string): number {
  const value = source.indexOf(fragment);
  expect(value, `Missing route-order fragment: ${fragment}`).toBeGreaterThanOrEqual(0);
  return value;
}

describe("U12 v1 route order contract", () => {
  it("keeps public mounts before authentication and module gating before business mounts", () => {
    expect(position('router.use("/time-clock", tempsDeplacementsDeviceRoutes)')).toBeLessThan(position("router.use(authenticateToken)"));
    expect(position("router.use(authenticateToken)")).toBeLessThan(position("router.use(moduleAccessGate)"));
    expect(position("router.use(moduleAccessGate)")).toBeLessThan(position('router.use("/outils", outilRoutes)'));
  });

  it("keeps every compatibility-sensitive collision group in explicit order", () => {
    for (const orderedFragments of [
      ['{ prefix: "/gammes", router: surfaceFinishGammeRoutes }', '{ prefix: "/gammes", router: gammesRoutes }'],
      ['{ prefix: "/admin/access", router: accessControlRoutes }', '{ prefix: "/admin", router: adminRoutes }'],
      ['{ prefix: "/production/execution", router: productionExecutionRoutes }', '{ prefix: "/production", router: productionRoutes }'],
      ['{ prefix: "/qualite/v2", router: quality360Routes }', '{ prefix: "/qualite", router: qualiteRoutes }'],
      ['{ prefix: "/commandes-fournisseurs", router: intercompanyPurchaseTrackingRoutes }', '{ prefix: "/commandes-fournisseurs", router: commandeFournisseurRoutes }'],
      ['{ prefix: "/metrologie/v2", router: metrology360Routes }', '{ prefix: "/metrologie", router: metrologieRoutes }'],
      ['{ prefix: "/traceability/identification", router: identificationRoutes }', '{ prefix: "/traceability", router: traceabilityRoutes }'],
    ]) {
      expect(position(orderedFragments[0])).toBeLessThan(position(orderedFragments[1]));
    }
  });

  it("keeps the historical Production and Quality role matrices exact", () => {
    expect(productionSource).toContain('hasLegacyRoleFragment(role, ["admin", "administrateur"])');
    expect(productionSource).toContain(
      'hasLegacyRoleFragment(role, ["production", "atelier", "secretaire", "secretariat"])',
    );
    expect(qualitySource).toContain('hasLegacyRoleFragment(role, ["admin", "administrateur"])');
    expect(qualitySource).toContain('hasLegacyRoleFragment(role, ["qualit", "quality", "qse"])');
  });
});
