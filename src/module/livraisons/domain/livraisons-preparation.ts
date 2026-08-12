import type { BonLivraisonStatut } from "../types/livraisons.types"

export function matchesLivraisonPickScanCode(
  scanCode: string,
  expected: {
    lot_code: string | null
    stock_trace_code: string | null
    qr_payload: string | null
  }
): boolean {
  const normalized = scanCode.trim().toUpperCase()
  if (!normalized) return false
  const candidates = [
    expected.lot_code,
    expected.stock_trace_code,
    expected.qr_payload,
    expected.stock_trace_code ? `CERP-STOCK:${expected.stock_trace_code}` : null,
  ]
  return candidates.some((candidate) => candidate?.trim().toUpperCase() === normalized)
}

export function deriveLivraisonPreparationState(args: {
  status: BonLivraisonStatut
  total: number
  confirmed: number
}): "NOT_READY" | "TO_PREPARE" | "IN_PROGRESS" | "COMPLETE" | "BLOCKED" {
  if (args.status === "DRAFT") return "NOT_READY"
  if (args.total === 0) return "BLOCKED"
  if (args.confirmed >= args.total) return "COMPLETE"
  if (args.confirmed > 0) return "IN_PROGRESS"
  return "TO_PREPARE"
}
