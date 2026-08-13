import { describe, expect, it } from "vitest";

import {
  assertDeliveryPolicyContentMutable,
  assertDeliveryPolicyTransition,
} from "../module/qualite/domain/quality-policy";

describe("#437 politique globale de liberation BL", () => {
  it.each([
    ["DRAFT", "IN_REVIEW"],
    ["IN_REVIEW", "SIGNED"],
    ["SIGNED", "ACTIVE"],
    ["ACTIVE", "SUPERSEDED"],
    ["ACTIVE", "REVOKED"],
  ] as const)("autorise %s vers %s", (from, to) => {
    expect(() => assertDeliveryPolicyTransition(from, to)).not.toThrow();
  });

  it("refuse l'activation directe et toute edition apres signature", () => {
    expect(() => assertDeliveryPolicyTransition("DRAFT", "ACTIVE")).toThrowError(/interdite/);
    expect(() => assertDeliveryPolicyContentMutable("ACTIVE")).toThrowError(/revision/);
  });
});
