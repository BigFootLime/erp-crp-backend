import { HttpError } from '../../../utils/httpError';
import { formatCumpDecimal, parseCumpDecimal } from '../../stock/domain/cump-decimal';

export type UrgencyDonor = {
  reservation_id: string; allocation_id: number; client_id: string; article_id: string;
  lane: string | null; version_compatible: boolean; protected_due_date: string | null;
  reservation_remaining: string; prepared_quantity: string; pending_quantity?: string;
  stock_batch_id: string; stock_level_id: string;
  batch_total: string; batch_reserved: string; batch_depreciated: string;
  level_total: string; level_reserved: string; level_depreciated: string;
  blocker: string | null;
};

const quantity = (value: string) => {
  try { return parseCumpDecimal(value); }
  catch { throw new HttpError(409, 'URGENCY_STOCK_INCONSISTENT', 'Les quantités du stock donneur doivent être vérifiées.'); }
};
const min = (a: bigint, b: bigint) => a < b ? a : b;
const positive = (value: bigint) => value > 0n ? value : 0n;
type Budget = { total: bigint; reserved: bigint; depreciated: bigint; candidates: bigint; committed: bigint; remaining: bigint };

/** A preview is not an authorization to withdraw. Existing donor reservations stay untouched. */
export function planDeliveryUrgency(args: {
  allocation_id: number; client_id: string; article_id: string;
  requested_quantity: string; uncovered_quantity: string; free_quantity: string;
  today: string; donors: readonly UrgencyDonor[];
}) {
  const requested = quantity(args.requested_quantity), uncovered = quantity(args.uncovered_quantity);
  if (requested <= 0n || requested > uncovered)
    throw new HttpError(422, 'URGENCY_QUANTITY_EXCEEDS_NEED', 'La quantité urgente doit rester dans le besoin non couvert de cette affaire.');
  const free = min(requested, quantity(args.free_quantity));
  let missing = requested - free;
  const batches = new Map<string, Budget>(), levels = new Map<string, Budget>(), seen = new Set<string>();
  const candidates = args.donors.map(donor => {
    if (seen.has(donor.reservation_id))
      throw new HttpError(409, 'URGENCY_DUPLICATE_RESERVATION', 'Une réservation donneuse apparaît plusieurs fois.');
    seen.add(donor.reservation_id);
    // Repeat identity and lane checks in the domain, even when SQL already filtered them.
    let blocker = donor.blocker;
    if (donor.client_id !== args.client_id) blocker = 'Autre client';
    else if (donor.allocation_id === args.allocation_id) blocker = 'Même affaire de livraison';
    else if (donor.article_id !== args.article_id || !donor.version_compatible) blocker = 'Article ou version incompatible';
    else if (donor.lane !== 'DELIVERY') blocker = 'Hors piste attente de livraison';
    else if (!donor.protected_due_date) blocker = 'Engagement de livraison manquant';
    else if (donor.protected_due_date < args.today) blocker = 'Affaire donneuse déjà en retard';
    const remaining = quantity(donor.reservation_remaining), prepared = quantity(donor.prepared_quantity);
    const pending = quantity(donor.pending_quantity ?? '0');
    if (prepared > remaining) blocker = 'Préparation supérieure à la réservation';
    const available = positive(remaining - prepared - pending);
    if (!blocker && available === 0n) blocker = pending > 0n
      ? 'Quantité déjà proposée pour une urgence' : 'Réservation déjà préparée pour un BL';
    if (!blocker) {
      for (const [map, id, totalValue, reservedValue, depreciatedValue] of [
        [batches, donor.stock_batch_id, donor.batch_total, donor.batch_reserved, donor.batch_depreciated],
        [levels, donor.stock_level_id, donor.level_total, donor.level_reserved, donor.level_depreciated],
      ] as const) {
        const total = quantity(totalValue), reserved = quantity(reservedValue), depreciated = quantity(depreciatedValue);
        const budget = map.get(id) ?? { total, reserved, depreciated, candidates: 0n, committed: 0n, remaining: 0n };
        if (budget.total !== total || budget.reserved !== reserved || budget.depreciated !== depreciated)
          throw new HttpError(409, 'URGENCY_STOCK_INCONSISTENT', 'Le stock a changé pendant le contrôle. Actualisez.');
        budget.candidates += available;
        budget.committed += remaining;
        map.set(id, budget);
      }
    }
    return { donor, blocker, available };
  });
  for (const map of [batches, levels]) for (const budget of map.values()) {
    if (budget.committed > budget.reserved)
      throw new HttpError(409, 'URGENCY_STOCK_INCONSISTENT', 'Les réservations donneuses dépassent le stock réservé.');
    // Preserve every other reservation, including clients and lanes outside this preview.
    budget.remaining = positive(budget.total - budget.depreciated - (budget.reserved - budget.candidates));
  }
  const rows = candidates.sort((a, b) =>
    (b.donor.protected_due_date ?? '').localeCompare(a.donor.protected_due_date ?? '') ||
    a.donor.reservation_id.localeCompare(b.donor.reservation_id)).map(({ donor, blocker, available }) => {
      let proposed = 0n;
      if (!blocker) {
        const batch = batches.get(donor.stock_batch_id)!, level = levels.get(donor.stock_level_id)!;
        proposed = min(missing, min(available, min(batch.remaining, level.remaining)));
        missing -= proposed; batch.remaining -= proposed; level.remaining -= proposed;
      }
      return { reservation_id: donor.reservation_id, allocation_id: donor.allocation_id,
        protected_due_date: donor.protected_due_date, blocker,
        unprepared_quantity: formatCumpDecimal(available), proposed_quantity: formatCumpDecimal(proposed) };
    });
  return { requested_quantity: formatCumpDecimal(requested), free_quantity: formatCumpDecimal(free),
    recovery_quantity: formatCumpDecimal(requested - free - missing), shortage_quantity: formatCumpDecimal(missing),
    requires_planner_validation: rows.some(row => quantity(row.proposed_quantity) > 0n),
    can_withdraw: false as const, rows };
}
