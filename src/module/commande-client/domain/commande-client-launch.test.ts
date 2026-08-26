import { describe, expect, it } from "vitest";

import { resolveCustomerOrderLaunchMode } from "./commande-client-launch";

describe("parcours de lancement d'une commande client", () => {
  it("conserve le planning lorsqu'au moins une opération existe", () => {
    expect(resolveCustomerOrderLaunchMode({ needsProduction: true, generatedOperationsCount: 2 }))
      .toBe("PRODUCTION_WITH_PLANNING");
  });

  it("conserve la validation planning lorsqu'un OF ne contient aucune opération", () => {
    expect(resolveCustomerOrderLaunchMode({ needsProduction: true, generatedOperationsCount: 0 }))
      .toBe("PRODUCTION_WITH_PLANNING");
  });

  it("conserve le parcours stock lorsqu'aucune production n'est nécessaire", () => {
    expect(resolveCustomerOrderLaunchMode({ needsProduction: false, generatedOperationsCount: 0 }))
      .toBe("STOCK_ONLY");
  });
});
