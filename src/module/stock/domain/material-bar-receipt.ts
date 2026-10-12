import { HttpError } from '../../../utils/httpError';

export type ReceivedBarGroup = { lengthMm: number; count: number };
const invalid = (message: string): never => { throw new HttpError(422, 'MATERIAL_BAR_RECEIPT_INVALID', message); };
const milli = (n: number) => {
  const value = Math.round(n * 1000);
  if (!Number.isFinite(n) || n <= 0 || n > 1e9 || Math.abs(n * 1000 - value) > 1e-6)
    invalid('La longueur doit être positive, avec trois décimales maximum.');
  return value;
};

/** Validate actual received bars against the purchase conversion already checked
 * by reception/quality. Never change canonical stock to match a guessed shape. */
export function receivedMaterialBarLengths(groups: readonly ReceivedBarGroup[], stockQuantityMm: number): number[] {
  const expected = milli(stockQuantityMm);
  if (!groups.length || groups.length > 1000) invalid('Renseignez les barres reçues (1 000 maximum par entrée).');
  const lengths: number[] = [];
  let total = 0;
  for (const group of groups) {
    const length = milli(group.lengthMm);
    if (!Number.isSafeInteger(group.count) || group.count <= 0 || group.count > 1000 || lengths.length + group.count > 1000)
      invalid('Le nombre de barres doit être entier, entre 1 et 1 000 par entrée.');
    total += length * group.count;
    if (!Number.isSafeInteger(total) || total > expected)
      invalid('La longueur totale des barres dépasse la quantité à mettre en stock. Vérifiez la quantité et la conversion d’achat.');
    for (let n = 0; n < group.count; n++) lengths.push(group.lengthMm);
  }
  if (total !== expected) invalid('La longueur totale des barres doit correspondre à la quantité à mettre en stock.');
  return lengths;
}

/** Suggested values require confirmation by the receiver. A configured 3 m
 * purchase length is not evidence of historical bars or an arbitrary last remnant. */
export function proposeReceivedMaterialBars(input: {
  required: boolean; receiptUnit: string; stockUnit: string; coefficient: number;
  quantity: number; sourceLengthMm?: number | null;
}) {
  const empty = { required: input.required, groups: null as ReceivedBarGroup[] | null,
    source: null as 'PURCHASE_CONVERSION' | 'ARTICLE' | null };
  if (!input.required || input.stockUnit.trim().toLowerCase() !== 'mm' || input.quantity <= 0) return empty;
  const purchaseBar = ['barre', 'barres', 'bar'].includes(input.receiptUnit.trim().toLowerCase());
  const length = purchaseBar ? input.coefficient : Number(input.sourceLengthMm);
  const count = Math.round(input.quantity * input.coefficient / length);
  try {
    const groups = [{ lengthMm: length, count }];
    receivedMaterialBarLengths(groups, input.quantity * input.coefficient);
    return { required: true, groups, source: purchaseBar ? 'PURCHASE_CONVERSION' as const : 'ARTICLE' as const };
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    return empty;
  }
}
