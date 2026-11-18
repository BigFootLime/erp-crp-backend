import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { repoRoot } from "../../../__tests__/helpers/repo-paths";
import { readSourceFunction } from "../../../__tests__/helpers/source-contract";

const source = (relativePath: string) => readFileSync(resolve(repoRoot, relativePath), "utf8");

describe("Quality 360 direct OUT writer contract (#616)", () => {
  it("keeps generic and both active delivery OUT posting paths behind their lot guards", () => {
    // The public stock façade deliberately delegates posting to the movement
    // core. Keep the contract on that owner: an OUT that is not the server
    // reservation-consumption path must pass the lot eligibility gate before
    // the movement branches into its posting workflow.
    const stockCore = source("src/module/stock/repository/stock-movement-core.repository.ts");
    const directOutGate = stockCore.slice(
      stockCore.indexOf("const directOutQualityDecisions"),
      stockCore.indexOf('if (m.movement_type === "TRANSFER")')
    );
    expect(directOutGate).toContain('m.movement_type === "OUT"');
    expect(directOutGate).toContain("!reservedConsumption");
    expect(directOutGate).toContain("await assertDirectOutMovementQualityEligibility");
    expect(directOutGate).toContain("lines: draftLines.rows");

    expect(stockCore).toContain("await recordDirectLotQualityConsumption");

    // Shipping an already prepared cart spends a locked, verified reservation.
    // It must reject an unreleased lot before inserting any stock movement.
    const reservationShipment = readSourceFunction(
      "src/module/livraisons/repository/livraisons.repository.ts", "repoShipLivraison"
    );
    const cartInsertAt = reservationShipment.indexOf("INSERT INTO public.stock_movements");
    expect(cartInsertAt).toBeGreaterThan(0);
    const cartBeforePosting = reservationShipment.slice(0, cartInsertAt);
    expect(cartBeforePosting).toContain("FOR UPDATE OF bla, r, sb, sl, l");
    expect(cartBeforePosting).toContain('allocation.reservation_status !== "ACTIVE"');
    expect(cartBeforePosting).toContain("verifiedQty + 1e-9 < qty");
    expect(cartBeforePosting).toMatch(/allocation\.lot_status[\s\S]*?"LOT_NOT_CONSUMABLE"/);

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
