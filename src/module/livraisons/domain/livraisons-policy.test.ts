import { describe, expect, it } from "vitest"

import {
  deliveryLotIsConsumable,
  deliveryQuantitiesMatch,
  deliveryQuantityAvailable,
  isLivraisonTransitionAllowed,
  shipmentBillingBoundary,
  shipmentConfirmationMatches,
  shipmentReceiptDecision,
} from "./livraisons-policy"

const statuses = ["DRAFT", "READY", "SHIPPED", "DELIVERED", "CANCELLED"] as const
const transitionCases = statuses.flatMap((from) =>
  statuses.map((to) => ({ from, to }))
)

describe("issue #226 — matrice métier factorisée", () => {
  it.each(transitionCases.map((testCase, index) => ({ id: `T${String(index + 1).padStart(3, "0")}`, ...testCase })))(
    "$id transition $from -> $to",
    ({ from, to }) => {
      const expected =
        from === to ||
        (from === "DRAFT" && (to === "READY" || to === "CANCELLED")) ||
        (from === "READY" && (to === "SHIPPED" || to === "CANCELLED")) ||
        (from === "SHIPPED" && to === "DELIVERED")
      expect(isLivraisonTransitionAllowed(from, to)).toBe(expected)
    }
  )

  const expectedQuantities = [0.001, 1, 2.5, 10, 999.999]
  const allocatedQuantities = [0, 0.001, 1, 2.5, 10, 999.999, 1000]
  const quantityCases = expectedQuantities.flatMap((expected) =>
    allocatedQuantities.map((allocated) => ({ expected, allocated }))
  )
  it.each(quantityCases.map((testCase, index) => ({ id: `Q${String(index + 1).padStart(3, "0")}`, ...testCase })))(
    "$id couverture $allocated / $expected",
    ({ expected, allocated }) => {
      expect(deliveryQuantitiesMatch(expected, allocated)).toBe(
        Math.abs(expected - allocated) <= 1e-9 && allocated > 0
      )
    }
  )

  const availabilityCases = [0, 1, 10, 100].flatMap((qty_on_hand) =>
    [0, 2].flatMap((qty_reserved) =>
      [0, 1].flatMap((qty_depreciated) =>
        [0, 2].map((own_reservation) => ({
          qty_on_hand,
          qty_reserved,
          qty_depreciated,
          own_reservation,
        }))
      )
    )
  )
  it.each(availabilityCases.map((testCase, index) => ({ id: `S${String(index + 1).padStart(3, "0")}`, ...testCase })))(
    "$id disponible physique/réservé/déprécié/propre",
    (testCase) => {
      expect(deliveryQuantityAvailable(testCase)).toBe(
        Math.max(
          testCase.qty_on_hand -
            testCase.qty_reserved -
            testCase.qty_depreciated +
            testCase.own_reservation,
          0
        )
      )
    }
  )

  const lotCases = [null, "lot-1"].flatMap((lotId) =>
    [null, "LIBERE", "BLOQUE", "EN_ATTENTE", "QUARANTAINE"].map((lotStatus) => ({
      lotId,
      lotStatus,
    }))
  )
  it.each(lotCases.map((testCase, index) => ({ id: `L${String(index + 1).padStart(3, "0")}`, ...testCase })))(
    "$id qualité lot $lotStatus",
    ({ lotId, lotStatus }) => {
      expect(deliveryLotIsConsumable(lotId, lotStatus)).toBe(
        lotId === null || lotStatus === "LIBERE"
      )
    }
  )

  it.each(Array.from({ length: 16 }, (_, index) => ({ id: `F${String(index + 1).padStart(3, "0")}` })))(
    "$id frontière de facturation constante",
    () => {
      expect(shipmentBillingBoundary()).toEqual({
        event_type: "DELIVERY.SHIPPED",
        invoice_created: false,
        billing_decision: "PENDING_DOWNSTREAM_REVIEW",
      })
    }
  )

  it.each([
    [null, "hash-a", "NEW"],
    ["hash-a", "hash-a", "REPLAY"],
    ["hash-a", "hash-b", "CONFLICT"],
  ] as const)("idempotence %s / %s -> %s", (existing, current, expected) => {
    expect(shipmentReceiptDecision(existing, current)).toBe(expected)
  })

  it.each([
    [1, 1, "a", "a", true],
    [1, 2, "a", "a", false],
    [2, 2, "a", "b", false],
    [3, 2, "a", "b", false],
  ] as const)(
    "confirmation version/hash %s/%s %s/%s",
    (expectedVersion, actualVersion, expectedHash, actualHash, valid) => {
      expect(
        shipmentConfirmationMatches({
          expectedVersion,
          actualVersion,
          expectedPreviewHash: expectedHash,
          actualPreviewHash: actualHash,
        })
      ).toBe(valid)
    }
  )
})
