import { HttpError } from "../../../utils/httpError";
import { formatCumpDecimal, parseCumpDecimal } from "../../stock/domain/cump-decimal";

export type ReceiptDeliveryDemand = {
  allocation_id: number;
  livraison_affaire_id: number;
  ordered: string;
  delivered: string;
  reserved_remaining: string;
  unreserved_prepared: string;
  due_date: string | null;
};

function quantity(value: string): bigint {
  try { return parseCumpDecimal(value); }
  catch { throw new HttpError(409, "RECEIPT_DELIVERY_COVERAGE_INVALID", "Les quantités de livraison doivent être vérifiées avant la réservation."); }
}

/** Prepared reservation-backed BLs are already included in reserved_remaining. */
export function allocateReceiptToDeliveryDemands(
  received: string,
  lineOrdered: string,
  demands: readonly ReceiptDeliveryDemand[],
  requestedAffaireId: number | null,
): Array<{ allocation_id: number; livraison_affaire_id: number; quantity: string }> {
  let remaining = quantity(received);
  const ordered = quantity(lineOrdered);
  const seen = new Set<number>();
  let assigned = 0n;
  let covered = 0n;
  for (const demand of demands) {
    if (seen.has(demand.allocation_id))
      throw new HttpError(409, "RECEIPT_DELIVERY_COVERAGE_INVALID", "Une affaire ne peut pas être comptée deux fois.");
    seen.add(demand.allocation_id);
    assigned += quantity(demand.ordered);
    covered += quantity(demand.delivered) + quantity(demand.reserved_remaining) + quantity(demand.unreserved_prepared);
  }
  if (assigned > ordered)
    throw new HttpError(409, "RECEIPT_DELIVERY_DEMAND_EXCEEDS_ORDER", "Les affaires dépassent la quantité commandée. Corrigez leur répartition.");
  const lineMissing = ordered > covered ? ordered - covered : 0n;
  remaining = remaining < lineMissing ? remaining : lineMissing;
  const result: ReturnType<typeof allocateReceiptToDeliveryDemands> = [];
  for (const demand of [...demands].sort((a, b) =>
    (a.due_date ?? "9999-12-31").localeCompare(b.due_date ?? "9999-12-31") || a.allocation_id - b.allocation_id)) {
    if (requestedAffaireId !== null && demand.livraison_affaire_id !== requestedAffaireId) continue;
    const rawMissing = quantity(demand.ordered) - quantity(demand.delivered)
      - quantity(demand.reserved_remaining) - quantity(demand.unreserved_prepared);
    const missing = rawMissing > 0n ? rawMissing : 0n;
    const applied = remaining < missing ? remaining : missing;
    if (applied <= 0n) continue;
    result.push({ allocation_id: demand.allocation_id, livraison_affaire_id: demand.livraison_affaire_id,
      quantity: formatCumpDecimal(applied) });
    remaining -= applied;
  }
  return result;
}
