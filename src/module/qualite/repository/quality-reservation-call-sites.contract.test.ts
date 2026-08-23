import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { repoRoot } from "../../../__tests__/helpers/repo-paths";

const reservationWriters = [
  "src/module/stock/repository/stock-reservation.repository.ts",
  "src/module/production/repository/production-receipts.repository.ts",
  "src/module/commande-client/repository/commande-client.repository.ts",
  "src/module/livraisons/repository/livraisons.repository.ts",
  "src/module/livraisons/repository/livraisons-shipment.repository.ts",
] as const;

describe("Quality 360 stock-reservation writer contract (#616)", () => {
  it("keeps every direct reservation writer behind the canonical operational gate", () => {
    for (const relativePath of reservationWriters) {
      const source = readFileSync(resolve(repoRoot, relativePath), "utf8");
      expect(source, relativePath).toContain("assertOperationalLotQualityEligibility");
      const insertAt = source.indexOf("INSERT INTO public.stock_reservations");
      expect(insertAt, relativePath).toBeGreaterThanOrEqual(0);
      const gateAt = source.lastIndexOf("await assertOperationalLotQualityEligibility", insertAt);
      expect(gateAt, relativePath).toBeGreaterThanOrEqual(0);
    }
  });

  it("does not charge an ACTIVE reservation a second time when it is consumed", () => {
    const relativePath = "src/module/stock/repository/stock-reservation.repository.ts";
    const source = readFileSync(resolve(repoRoot, relativePath), "utf8");
    const consumeGate = source.slice(source.indexOf("async function transitionReservation"));
    expect(consumeGate).toMatch(/RESERVATION_CONSUME[\s\S]*?assertOperationalLotQualityEligibility\([\s\S]*?qty: 0,/);
  });
});
