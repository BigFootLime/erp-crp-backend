import { describe, expect, it } from "vitest";

import {
  hasOutillageCapability,
  nextAllocationState,
  roleHasOutillageCapability,
  type AllocationState,
} from "../module/outils/domain/outillage-lifecycle";
import {
  createToolParameterVersionSchema,
  replaceToolRequirementsSchema,
  reserveToolSchema,
} from "../module/outils/validators/outillage-lifecycle.validators";

const reserved = (): AllocationState => ({
  reserved_quantity: 4,
  issued_quantity: 0,
  returned_quantity: 0,
  broken_quantity: 0,
  worn_quantity: 0,
  status: "RESERVED",
});

describe("SOL-20 outillage lifecycle", () => {
  it("covers partial issue, return, break and wear without exceeding the issue", () => {
    const issued = nextAllocationState(reserved(), "ISSUE", 4);
    const returned = nextAllocationState(issued, "RETURN", 1);
    const broken = nextAllocationState(returned, "BREAK", 1);
    const worn = nextAllocationState(broken, "WEAR", 2);
    expect(worn).toMatchObject({
      returned_quantity: 1,
      broken_quantity: 1,
      worn_quantity: 2,
      status: "CLOSED",
    });
  });

  it("refuses a return or loss larger than the actual issued quantity", () => {
    expect(() => nextAllocationState(nextAllocationState(reserved(), "ISSUE", 2), "RETURN", 3))
      .toThrow("DISPOSITION_EXCEEDS_ISSUED");
  });

  it("refuses to cancel while an issued tool is still outstanding", () => {
    expect(() => nextAllocationState(nextAllocationState(reserved(), "ISSUE", 1), "CANCEL", 4))
      .toThrow("ISSUED_ALLOCATION_CANNOT_BE_CANCELLED");
  });

  it("keeps a partially issued reservation open after its issued tool returns", () => {
    const result = nextAllocationState(
      {
        reserved_quantity: 3,
        issued_quantity: 1,
        returned_quantity: 0,
        broken_quantity: 0,
        worn_quantity: 0,
        status: "ISSUED",
      },
      "RETURN",
      1
    );

    expect(result).toMatchObject({
      reserved_quantity: 3,
      issued_quantity: 1,
      returned_quantity: 1,
      status: "PARTIALLY_RETURNED",
    });
  });

  it("releases the unused remainder after a partial lifecycle is fully disposed", () => {
    const result = nextAllocationState(
      {
        reserved_quantity: 3,
        issued_quantity: 1,
        returned_quantity: 1,
        broken_quantity: 0,
        worn_quantity: 0,
        status: "PARTIALLY_RETURNED",
      },
      "CANCEL",
      2
    );

    expect(result).toMatchObject({ reserved_quantity: 1, issued_quantity: 1, status: "CLOSED" });
  });

  it("enforces differentiated backend capabilities", () => {
    expect(roleHasOutillageCapability("Opérateur atelier", "operate")).toBe(true);
    expect(roleHasOutillageCapability("Opérateur atelier", "configure")).toBe(false);
    expect(roleHasOutillageCapability("Method", "configure")).toBe(true);
    expect(roleHasOutillageCapability("Production | Atelier", "configure")).toBe(true);
    expect(roleHasOutillageCapability("Stock | Magasin", "operate")).toBe(true);
    expect(roleHasOutillageCapability("Secretaire", "operate")).toBe(false);
    expect(hasOutillageCapability(true, "Secretaire", "operate")).toBe(false);
    expect(hasOutillageCapability(false, "Method", "configure")).toBe(false);
    expect(hasOutillageCapability(true, "Method", "configure")).toBe(true);
  });

  it("rejects duplicate tool requirements and missing traceability", () => {
    const version = "11111111-1111-4111-8111-111111111111";
    expect(replaceToolRequirementsSchema.safeParse({
      reason: "Définition initiale",
      requirements: [
        { id_outil: 7, required_quantity: 1 },
        { id_outil: 7, required_quantity: 2 },
      ],
    }).success).toBe(false);
    expect(reserveToolSchema.safeParse({
      id_outil: 7,
      piece_technique_id: version,
      piece_technique_version_id: version,
      quantity: 1,
    }).success).toBe(false);
  });

  it("does not turn missing cost or life data into zero", () => {
    expect(createToolParameterVersionSchema.parse({
      effective_from: "2026-08-13T08:00:00+02:00",
      unit_cost: null,
      expected_life_pieces: 500,
      currency: "EUR",
      source: "Fiche fabricant validée",
      source_observed_at: "2026-08-12T08:00:00+02:00",
      reliability: "VERIFIED",
      change_reason: "Création du paramètre",
    }).unit_cost).toBeNull();
    expect(createToolParameterVersionSchema.safeParse({
      effective_from: "2026-08-13T08:00:00+02:00",
      unit_cost: null,
      expected_life_pieces: null,
      source: "Incomplète",
      source_observed_at: "2026-08-12T08:00:00+02:00",
      reliability: "DECLARED",
      change_reason: "Création du paramètre",
    }).success).toBe(false);
  });
});
