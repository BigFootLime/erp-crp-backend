import type { SubcontractFlow } from './subcontract-flow.types';

/** Completion is a historical execution fact, not an entitlement to stock.
 * Partial returns and unresolved losses must not look like finished treatment.
 * Availability is still evaluated against current Quality on every transfer. */
export function completedSubcontractEvidence(target: number, flows: SubcontractFlow[]) {
  if (!Number.isFinite(target) || target <= 0 || !flows.length) return null;
  const close = (a: number, b: number) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 1e-8;
  const units = new Set(flows.map(f => f.unit.trim().toUpperCase()));
  if (units.size !== 1 || !units.has('U')) return null;
  if (flows.some(f => f.status !== 'CLOSED' || !close(f.custody, 0) || !close(f.issued, f.returned))) return null;
  if (!close(flows.reduce((sum, f) => sum + f.issued, 0), target)) return null;
  for (const f of flows) {
    if (!close(f.returns.reduce((sum, r) => sum + r.quantity, 0), f.returned)) return null;
    if (!close(f.released, f.returned) || !close(f.transferred, f.returned)) return null;
    if (f.returns.some(r => !r.receiptLineId || r.blockers.length || !close(r.quantity, r.released) || !close(r.quantity, r.transferred))) return null;
  }
  const returns = flows.flatMap(f => f.returns);
  if (new Set(returns.map(r => r.id)).size !== returns.length) return null;
  return { quantity: target, unit: 'U', packageIds: flows.map(f => f.packageId),
    returns: returns.map(r => ({originId:r.id, receiptLineId:r.receiptLineId, lotId:r.lotId,
      quantity:r.quantity, released:r.released, transferred:r.transferred})),
    departedAt: flows.map(f => f.departedAt).filter((d):d is string => d !== null).sort()[0] ?? null };
}
