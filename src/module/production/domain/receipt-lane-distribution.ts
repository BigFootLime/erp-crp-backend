import { HttpError } from "../../../utils/httpError";
import { parseCumpDecimal, formatCumpDecimal } from "../../stock/domain/cump-decimal";
import type { StockLane } from "../../stock/domain/stock-lanes";

export type ReceiptReservationAllocation = {
  reservation_id: string;
  lane: Exclude<StockLane, "FREE">;
  quantity: string;
  source_reservation_id?: string;
};
export type ReceiptLaneDistribution = {
  received_quantity: string;
  physical_routing_applied: boolean;
  destinations: Array<{ lane: StockLane; quantity: string; reservations: ReceiptReservationAllocation[];
    location_id?: string; location_label?: string; movement_id?: string | null; source_location_id?: string;
    stock_level_id?: string; stock_batch_id?: string }>;
};

/** Only canonical reservation deltas are assigned. Launched OF quantity is not an entitlement. */
export function distributeReceiptToStockLanes(
  receivedQuantity: string,
  allocations: readonly ReceiptReservationAllocation[],
): ReceiptLaneDistribution {
  let received: bigint;
  try { received = parseCumpDecimal(receivedQuantity); }
  catch { throw new HttpError(422, "RECEIPT_LANE_QUANTITY_INVALID", "Quantité reçue invalide pour la répartition."); }
  if (received <= 0n) throw new HttpError(422, "RECEIPT_LANE_QUANTITY_INVALID", "La quantité reçue doit être positive.");
  const seen = new Set<string>();
  const quantities = { DELIVERY: 0n, ASSEMBLY: 0n };
  const reservations: Record<"DELIVERY" | "ASSEMBLY", ReceiptReservationAllocation[]> = { DELIVERY: [], ASSEMBLY: [] };
  for (const allocation of allocations) {
    if (!allocation.reservation_id || seen.has(allocation.reservation_id)
      || (allocation.lane !== "DELIVERY" && allocation.lane !== "ASSEMBLY"))
      throw new HttpError(409, "RECEIPT_LANE_ALLOCATION_INVALID", "Une réservation doit correspondre à une seule affectation de réception.");
    let quantity: bigint;
    try { quantity = parseCumpDecimal(allocation.quantity); }
    catch { throw new HttpError(409, "RECEIPT_LANE_ALLOCATION_INVALID", "Quantité réservée invalide pour la répartition."); }
    if (quantity <= 0n) throw new HttpError(409, "RECEIPT_LANE_ALLOCATION_INVALID", "La quantité affectée doit être positive.");
    seen.add(allocation.reservation_id);
    quantities[allocation.lane] += quantity;
    reservations[allocation.lane].push({ ...allocation, quantity: formatCumpDecimal(quantity) });
  }
  const free = received - quantities.DELIVERY - quantities.ASSEMBLY;
  if (free < 0n) throw new HttpError(409, "RECEIPT_LANE_OVERALLOCATED", "Les affectations dépassent la réception physique. Rechargez les réservations.");
  const destinations: ReceiptLaneDistribution["destinations"] = [];
  for (const lane of ["DELIVERY", "ASSEMBLY"] as const) {
    if (quantities[lane] > 0n) destinations.push({ lane, quantity: formatCumpDecimal(quantities[lane]), reservations: reservations[lane] });
  }
  if (free > 0n) destinations.push({ lane: "FREE", quantity: formatCumpDecimal(free), reservations: [] });
  return { received_quantity: formatCumpDecimal(received), physical_routing_applied: false, destinations };
}
