import { HttpError } from '../../../utils/httpError';
import { formatCumpDecimal, parseCumpDecimal } from '../../stock/domain/cump-decimal';

export type UrgencyRestitutionRecovery = {
  id: string; quantity: string; replenished: string; donor_uncovered: string;
};
export type UrgencyRestitutionTransfer = {
  id: string; recovery_id: string; reservation_id: string; quantity: string;
};
export type UrgencyRestitutionReservation = {
  id: string; remaining: string; prepared: string; consumed: string;
  identity_valid: boolean; blocker: string | null;
};
type Issue = { code: string; message: string; reservation_id: string | null };

const quantity = (value: string) => {
  try { return parseCumpDecimal(value); }
  catch { throw new HttpError(409, 'URGENCY_RETURN_INCONSISTENT', 'Vérifiez les quantités du prélèvement et des réservations.'); }
};
const min = (a: bigint, b: bigint) => a < b ? a : b;
const inconsistent = () => new HttpError(409, 'URGENCY_RETURN_INCONSISTENT',
  'Le prélèvement, ses lots et les quantités de récupération doivent être rapprochés.');

/** Read-only restitution proposal. A return never recreates stock already shipped,
 * undoes an issued invoice, or counts already-produced replacements twice.
 * The mutation must relock and recheck this proposal, then post every stock leg. */
export function planUrgencyRestitution(input: {
  quantity: string; recoveries: readonly UrgencyRestitutionRecovery[];
  transfers: readonly UrgencyRestitutionTransfer[]; reservations: readonly UrgencyRestitutionReservation[];
}) {
  const expected = quantity(input.quantity);
  if (expected <= 0n) throw inconsistent();
  const recoveries = new Map<string, { quantity: bigint; transferred: bigint; toDonor: bigint }>();
  for (const row of input.recoveries) {
    const requested = quantity(row.quantity), replenished = quantity(row.replenished);
    if (recoveries.has(row.id) || requested <= 0n || replenished > requested) throw inconsistent();
    recoveries.set(row.id, { quantity: requested, transferred: 0n,
      toDonor: min(requested - replenished, quantity(row.donor_uncovered)) });
  }
  const reservations = new Map<string, UrgencyRestitutionReservation>();
  for (const row of input.reservations) {
    if (reservations.has(row.id)) throw inconsistent();
    reservations.set(row.id, row);
  }
  const used = new Set<string>(), perReservation = new Map<string, bigint>();
  let transferred = 0n;
  for (const row of input.transfers) {
    const amount = quantity(row.quantity), recovery = recoveries.get(row.recovery_id);
    if (used.has(row.id) || amount <= 0n || !recovery) throw inconsistent();
    used.add(row.id); transferred += amount; recovery.transferred += amount;
    perReservation.set(row.reservation_id, (perReservation.get(row.reservation_id) ?? 0n) + amount);
  }
  if (transferred !== expected || [...recoveries.values()].some(row => row.quantity !== row.transferred)) throw inconsistent();
  const issues: Issue[] = [];
  for (const [id, amount] of perReservation) {
    const row = reservations.get(id);
    const issue = (code: string, message: string) => issues.push({ code, message, reservation_id: id });
    if (!row || !row.identity_valid) {
      issue('URGENCY_RETURN_RESERVATION_CHANGED', 'La réservation ou son lot a changé. Rapprochez le stock avant de restituer.');
      continue;
    }
    const remaining = quantity(row.remaining), prepared = quantity(row.prepared), consumed = quantity(row.consumed);
    // Attribution within a shared lot reservation is not serial-level evidence.
    // Do not infer that shipped units were a different request's units.
    if (consumed > 0n) issue('URGENCY_RETURN_ALREADY_SHIPPED',
      'Des pièces de cette réservation ont été expédiées. Enregistrez leur retour et leur contrôle avant de restituer.');
    else if (prepared > 0n) issue('URGENCY_RETURN_PREPARED',
      'Des pièces sont préparées pour un BL. Retirez leur préparation avant de restituer.');
    else if (remaining < amount) issue('URGENCY_RETURN_SHORTAGE',
      'La réservation ne couvre plus toutes les pièces prélevées. Rapprochez les quantités.');
    if (row.blocker) issue('URGENCY_RETURN_STOCK_BLOCKED', row.blocker);
  }
  let toDonor = 0n, toFree = 0n;
  const lines = [...input.transfers].sort((a, b) => a.recovery_id.localeCompare(b.recovery_id) || a.id.localeCompare(b.id)).map(row => {
    const recovery = recoveries.get(row.recovery_id)!, amount = quantity(row.quantity);
    const donor = min(amount, recovery.toDonor), free = amount - donor;
    recovery.toDonor -= donor; toDonor += donor; toFree += free;
    return { transfer_id: row.id, recovery_id: row.recovery_id, reservation_id: row.reservation_id,
      quantity: formatCumpDecimal(amount), donor_quantity: formatCumpDecimal(donor), free_quantity: formatCumpDecimal(free) };
  });
  return { can_restore: issues.length === 0, quantity: formatCumpDecimal(expected),
    donor_quantity: formatCumpDecimal(toDonor), free_quantity: formatCumpDecimal(toFree), lines, issues };
}
