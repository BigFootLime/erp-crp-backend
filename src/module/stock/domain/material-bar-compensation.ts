import { z } from 'zod';
import { HttpError } from '../../../utils/httpError';
import { reconcileMaterialBars } from './material-bars';
import type { MaterialBarMovementStock } from './material-bar-movement';

export type MaterialBarMovementProof = { barId: string; action: string; before: unknown; after: unknown };
const length = z.number().finite().min(0).max(1e9).refine(n => Math.abs(n * 1000 - Math.round(n * 1000)) < 1e-6);
const state = z.object({ id: z.string().min(1), batchId: z.string().min(1), lengthMm: length,
  version: z.number().int().positive() }).passthrough();
const afterState = state.extend({ source: z.literal('STOCK_MOVEMENT') }).passthrough();
function changed(message: string): never { throw new HttpError(409, 'MATERIAL_BAR_COMPENSATION_CHANGED', message); }
const milli = (value: number) => Math.round(value * 1000);

/** Invert immutable bar proofs, never caller-entered replacement geometry.
 * A later cut, move or reconciliation must be corrected first. Reservations
 * may coexist with a restoration; removal and relocation require free bars. */
export function planMaterialBarCompensation(input: {
  original: { batchId: string; type: string; quantity: number };
  source: MaterialBarMovementStock; destinationBatchId?: string;
  proofs: readonly MaterialBarMovementProof[];
}) {
  const { original, source, proofs, destinationBatchId } = input;
  const adjustment = ['ADJUST', 'ADJUSTMENT'].includes(original.type);
  const kind = original.type === 'TRANSFER' ? 'TRANSFER'
    : original.type === 'OUT' || (adjustment && original.quantity < 0) ? 'RESTORE'
    : original.type === 'IN' || (adjustment && original.quantity > 0) ? 'RETIRE' : null;
  if (!kind || !length.safeParse(Math.abs(original.quantity)).success || original.quantity === 0
    || (!adjustment && original.quantity < 0)) changed('Ce mouvement ne possède pas de compensation physique prise en charge.');
  if (source.status !== 'CONFIRMED') changed('Confirmez les barres présentes avant de corriger ce mouvement.');
  const reconciled = reconcileMaterialBars({ bars: source.bars, holds: source.holds,
    batches: [source.batch], reservations: source.reservations });
  if (!proofs.length || proofs.length > 1000) changed('L’historique des barres de ce mouvement est incomplet.');
  if (kind === 'TRANSFER' ? destinationBatchId !== original.batchId || source.batch.id === original.batchId
    : source.batch.id !== original.batchId || !!destinationBatchId)
    changed('La compensation doit reprendre les emplacements du mouvement d’origine.');
  const selected = new Set<string>();
  const changes = proofs.map(proof => {
    const after = afterState.safeParse(proof.after);
    const bar = source.bars.find(item => item.id === proof.barId);
    if (!after.success || !bar || selected.has(proof.barId) || after.data.id !== proof.barId
      || after.data.batchId !== source.batch.id || bar.batchId !== source.batch.id
      || bar.version !== after.data.version || milli(bar.lengthMm) !== milli(after.data.lengthMm))
      changed('Une barre a été utilisée, déplacée ou recomptée depuis ce mouvement. Corrigez d’abord les opérations suivantes.');
    selected.add(proof.barId);
    let restoredMm = 0;
    if (kind === 'RETIRE') {
      if (proof.action !== 'INITIALIZE' || proof.before !== null || after.data.version !== 1 || after.data.lengthMm <= 0)
        changed('La preuve d’entrée de cette barre est incomplète.');
    } else {
      const before = state.safeParse(proof.before);
      if (!before.success || before.data.id !== proof.barId || before.data.batchId !== original.batchId
        || before.data.version + 1 !== after.data.version)
        changed('La preuve du mouvement de cette barre est incomplète.');
      restoredMm = before.data.lengthMm;
      if (kind === 'RESTORE' ? proof.action !== 'CUT' || restoredMm <= bar.lengthMm
        : proof.action !== 'MOVE' || milli(restoredMm) !== milli(bar.lengthMm))
        changed('L’historique des longueurs ne correspond pas au mouvement d’origine.');
    }
    if (kind !== 'RESTORE' && (reconciled.heldByBar.get(bar.id) ?? 0) > 0)
      changed('Cette barre est réservée. Libérez sa réservation avant de corriger son entrée ou son transfert.');
    return { bar, restoredMm, nextVersion: bar.version + 1 };
  });
  const quantity = changes.reduce((sum, change) => sum + (kind === 'RESTORE'
    ? milli(change.restoredMm) - milli(change.bar.lengthMm) : milli(change.bar.lengthMm)), 0);
  if (quantity !== milli(Math.abs(original.quantity))) changed('L’historique ne couvre pas toute la quantité du mouvement.');
  if (kind === 'RESTORE' && milli(source.batch.physicalMm) + quantity > 1e12)
    changed('La restitution dépasserait la capacité de ce lot.');
  return { kind, quantityMm: quantity / 1000, changes };
}
