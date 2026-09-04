import { describe, expect, it } from "vitest";

import {
  resolveCustomerOrderLaunchMode,
  resolveDeliveryReadinessState,
} from "./commande-client-launch";

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

describe("disponibilitÃ© d'une tranche de livraison", () => {
  it("attend la technique lorsque le dossier n'est pas exploitable", () => {
    expect(resolveDeliveryReadinessState({
      technicalWarningCount: 1,
      carriesOpenProduction: true,
      reservedQuantity: 4,
    })).toBe("WAITING_TECHNICAL");
  });

  it("n'expose pas Ã  Atelier BL une tranche groupÃ©e encore en production", () => {
    expect(resolveDeliveryReadinessState({
      technicalWarningCount: 0,
      carriesOpenProduction: true,
      reservedQuantity: 4,
    })).toBe("WAITING_STOCK");
  });

  it("rend livrable une tranche autonome dont le stock est rÃ©servÃ©", () => {
    expect(resolveDeliveryReadinessState({
      technicalWarningCount: 0,
      carriesOpenProduction: false,
      reservedQuantity: 4,
    })).toBe("READY_FOR_BL");
  });
});
