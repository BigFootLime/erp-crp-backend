import { describe, expect, it } from "vitest";

import { evaluateOtifOrder, reliabilityFromCoverage } from "./direction-dashboard";

describe("direction dashboard metric policy", () => {
  it("évalue l'OTIF au grain commande et exige que toutes les lignes soient complètes à temps", () => {
    expect(
      evaluateOtifOrder([
        { promisedDate: "2026-08-10", orderedQuantity: 2, completionDate: "2026-08-09" },
        { promisedDate: "2026-08-11", orderedQuantity: 1, completionDate: "2026-08-11" },
      ])
    ).toEqual({ eligible: true, onTimeInFull: true });

    expect(
      evaluateOtifOrder([
        { promisedDate: "2026-08-10", orderedQuantity: 2, completionDate: "2026-08-11" },
        { promisedDate: "2026-08-11", orderedQuantity: 1, completionDate: "2026-08-11" },
      ])
    ).toEqual({ eligible: true, onTimeInFull: false });
  });

  it("refuse un OTIF faussement précis quand une date promise manque", () => {
    expect(
      evaluateOtifOrder([
        { promisedDate: null, orderedQuantity: 1, completionDate: "2026-08-10" },
      ])
    ).toEqual({ eligible: false, onTimeInFull: null });
  });

  it("distingue couverture complète, partielle et absente", () => {
    expect(reliabilityFromCoverage(10, 10)).toBe("MEASURED");
    expect(reliabilityFromCoverage(10, 8)).toBe("PARTIAL");
    expect(reliabilityFromCoverage(10, 0)).toBe("UNAVAILABLE");
    expect(reliabilityFromCoverage(0, 0)).toBe("UNAVAILABLE");
  });
});
