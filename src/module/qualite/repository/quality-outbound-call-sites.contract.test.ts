import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { repoRoot } from "../../../__tests__/helpers/repo-paths";

const source = (relativePath: string) => readFileSync(resolve(repoRoot, relativePath), "utf8");

describe("Quality 360 direct OUT writer contract (#616)", () => {
  it("keeps generic and both delivery OUT posting paths behind the operational lot gate", () => {
    const stock = source("src/module/stock/repository/stock.repository.ts");
    expect(stock).toContain("assertDirectOutMovementQualityEligibility");
    expect(stock).toContain('m.movement_type === "OUT"');

    const legacyDelivery = source("src/module/livraisons/repository/livraisons.repository.ts");
    expect(legacyDelivery).toContain("assertOperationalLotQualityEligibility");
    expect(legacyDelivery).toContain("recordDirectLotQualityConsumption");
    const legacyInsertAt = legacyDelivery.indexOf("VALUES ($1,'OUT'::public.movement_type,'DRAFT'");
    expect(legacyDelivery.lastIndexOf("await assertOperationalLotQualityEligibility", legacyInsertAt)).toBeGreaterThanOrEqual(0);

    const shipment = source("src/module/livraisons/repository/livraisons-shipment.repository.ts");
    const gateCalls = shipment.match(/await assertOperationalLotQualityEligibility/g) ?? [];
    // Preparation spends the entitlement. Final shipment revalidates the
    // already-reserved lot with zero incremental quantity.
    expect(gateCalls).toHaveLength(2);
    const shipmentGate = shipment.slice(shipment.indexOf("export async function repoShipLivraison"));
    expect(shipmentGate).toMatch(/assertOperationalLotQualityEligibility\([\s\S]*?qty: 0,[\s\S]*?purpose: "RESERVE"/);
  });

  it("documents the sole direct posted OUT exception as a Quality-owned NC disposition", () => {
    const quality = source("src/module/qualite/repository/qualite.repository.ts");
    expect(quality).toContain("createPostedStockMovementForDisposition");
    expect(quality).toContain("repoCreateNonConformityDisposition");
    expect(quality).toContain('movement_type: "OUT" | "SCRAP"');
  });

  it("locks a lot before publishing an NC that can quarantine it", () => {
    const quality = source("src/module/qualite/repository/qualite.repository.ts");
    const createNc = quality.slice(
      quality.indexOf("export async function repoCreateNonConformity"),
      quality.indexOf("export async function repoPatchNonConformity"),
    );
    const lotLockAt = createNc.indexOf("SELECT lot_status FROM public.lots WHERE id = $1::uuid FOR UPDATE");
    const insertAt = createNc.indexOf("INSERT INTO non_conformity");
    expect(lotLockAt).toBeGreaterThanOrEqual(0);
    expect(lotLockAt).toBeLessThan(insertAt);
  });
});
