import { HttpError } from "../../../utils/httpError";
import { formatCumpDecimal, parseCumpDecimal } from "../../stock/domain/cump-decimal";

export type RecoveryStockCandidate = {
  stock_batch_id: string; stock_level_id: string; lot_id: string;
  batch_available: string; level_available: string; quality_available: string;
  blocker: string | null;
};

/** FIFO input; share level and quality allowances across multiple physical batches. */
export function planDeliveryStockRecovery(missing: string, candidates: readonly RecoveryStockCandidate[]) {
  let remaining = parseCumpDecimal(missing);
  if (remaining < 0n) throw new HttpError(409, "DELIVERY_COVERAGE_INVALID", "Vérifiez les quantités de l'affaire.");
  const levels = new Map<string, bigint>(), lots = new Map<string, bigint>();
  const seen = new Set<string>();
  const rows: Array<{ stock_batch_id: string; quantity: string }> = [];
  for (const c of candidates) {
    if (seen.has(c.stock_batch_id)) throw new HttpError(409, "DELIVERY_STOCK_DUPLICATE", "Une position de stock est comptée deux fois.");
    seen.add(c.stock_batch_id);
    if (c.blocker) continue;
    const level = parseCumpDecimal(c.level_available), quality = parseCumpDecimal(c.quality_available);
    if (!levels.has(c.stock_level_id)) levels.set(c.stock_level_id, level);
    if (!lots.has(c.lot_id)) lots.set(c.lot_id, quality);
    const quantity = [remaining, parseCumpDecimal(c.batch_available), levels.get(c.stock_level_id)!, lots.get(c.lot_id)!]
      .reduce((a, b) => a < b ? a : b);
    if (quantity <= 0n) continue;
    rows.push({ stock_batch_id: c.stock_batch_id, quantity: formatCumpDecimal(quantity) });
    remaining -= quantity;
    levels.set(c.stock_level_id, levels.get(c.stock_level_id)! - quantity);
    lots.set(c.lot_id, lots.get(c.lot_id)! - quantity);
  }
  return { rows, reserved_quantity: formatCumpDecimal(parseCumpDecimal(missing) - remaining), missing_quantity: formatCumpDecimal(remaining) };
}
