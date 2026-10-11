import { HttpError } from '../../../utils/httpError';
import { formatCumpDecimal, parseCumpDecimal } from '../../stock/domain/cump-decimal';

type Source = {
  reservation_id: string; allocation_id: number; proposed_quantity: string;
  protected_due_date: string | null;
};
type Preview = {
  free_quantity: string; shortage_quantity: string; recovery_quantity: string;
  requested_quantity: string; donors: Source[];
};

/** The draft covers only the proposed loan. Available free stock must be reserved first. */
export function buildUrgencyRecoveries(preview: Preview) {
  if (parseCumpDecimal(preview.free_quantity) > 0n)
    throw new HttpError(409, 'URGENCY_USE_FREE_STOCK_FIRST', 'Réservez d’abord le stock libre proposé, puis actualisez le besoin urgent.');
  if (parseCumpDecimal(preview.shortage_quantity) > 0n)
    throw new HttpError(409, 'URGENCY_DONORS_INSUFFICIENT', 'La piste livraison ne couvre pas cette quantité. Réduisez la demande ou préparez un OF distinct.');
  const expected = parseCumpDecimal(preview.requested_quantity);
  if (expected <= 0n || parseCumpDecimal(preview.recovery_quantity) !== expected)
    throw new HttpError(409, 'URGENCY_RECOVERY_INVALID', 'La récupération doit couvrir exactement la quantité empruntée.');
  const groups = new Map<number, { allocation_id: number; quantity: bigint; due_date: string; sources: Source[] }>();
  let total = 0n;
  for (const source of preview.donors) {
    const quantity = parseCumpDecimal(source.proposed_quantity);
    if (quantity === 0n) continue;
    if (!source.protected_due_date)
      throw new HttpError(409, 'URGENCY_DUE_DATE_REQUIRED', 'L’affaire donneuse doit avoir un engagement de livraison.');
    const group = groups.get(source.allocation_id) ?? {
      allocation_id: source.allocation_id, quantity: 0n, due_date: source.protected_due_date, sources: [],
    };
    group.quantity += quantity;
    if (source.protected_due_date < group.due_date) group.due_date = source.protected_due_date;
    group.sources.push(source); groups.set(source.allocation_id, group); total += quantity;
  }
  if (total !== expected)
    throw new HttpError(409, 'URGENCY_RECOVERY_INVALID', 'La somme des prélèvements ne correspond pas à la récupération.');
  return [...groups.values()].sort((a, b) => a.allocation_id - b.allocation_id)
    .map(group => ({ ...group, quantity: formatCumpDecimal(group.quantity) }));
}
