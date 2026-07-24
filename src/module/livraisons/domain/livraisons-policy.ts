import type { BonLivraisonStatut } from "../types/livraisons.types"

const ALLOWED_TRANSITIONS: Record<BonLivraisonStatut, readonly BonLivraisonStatut[]> = {
  DRAFT: ["READY", "CANCELLED"],
  READY: ["SHIPPED", "CANCELLED"],
  SHIPPED: ["DELIVERED"],
  DELIVERED: [],
  CANCELLED: [],
}

export function isLivraisonTransitionAllowed(
  from: BonLivraisonStatut,
  to: BonLivraisonStatut
): boolean {
  return from === to || ALLOWED_TRANSITIONS[from].includes(to)
}

export function deliveryQuantitiesMatch(expected: number, allocated: number): boolean {
  return Number.isFinite(expected) &&
    Number.isFinite(allocated) &&
    expected > 0 &&
    allocated > 0 &&
    Math.abs(expected - allocated) <= 1e-9
}

export function deliveryQuantityAvailable(args: {
  qty_on_hand: number
  qty_reserved: number
  qty_depreciated: number
  own_reservation: number
}): number {
  return Math.max(
    args.qty_on_hand -
      args.qty_reserved -
      args.qty_depreciated +
      args.own_reservation,
    0
  )
}

export function deliveryLotIsConsumable(
  lotId: string | null,
  lotStatus: string | null
): boolean {
  return lotId === null || lotStatus === "LIBERE"
}

export function shipmentBillingBoundary() {
  return {
    event_type: "DELIVERY.SHIPPED" as const,
    invoice_created: false as const,
    billing_decision: "PENDING_DOWNSTREAM_REVIEW" as const,
  }
}

export function shipmentReceiptDecision(
  existingRequestHash: string | null,
  currentRequestHash: string
): "NEW" | "REPLAY" | "CONFLICT" {
  if (existingRequestHash === null) return "NEW"
  return existingRequestHash === currentRequestHash ? "REPLAY" : "CONFLICT"
}

export function shipmentConfirmationMatches(args: {
  expectedVersion: number
  actualVersion: number
  expectedPreviewHash: string
  actualPreviewHash: string
}): boolean {
  return (
    args.expectedVersion === args.actualVersion &&
    args.expectedPreviewHash === args.actualPreviewHash
  )
}
