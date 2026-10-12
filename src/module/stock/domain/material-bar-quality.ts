import { HttpError } from '../../../utils/httpError';
import { reconcileMaterialBars } from './material-bars';
import type { MaterialBarMovementStock, MaterialBarQualityCommand } from './material-bar-movement';

const milli = (value: number) => {
  const result = Math.round(value * 1000);
  if (!Number.isFinite(value) || value < 0 || value > 1e9 || Math.abs(result - value * 1000) > 1e-6)
    throw new HttpError(422, 'MATERIAL_BAR_QUALITY_INVALID', 'Renseignez une longueur avec trois décimales maximum.');
  return result;
};
function changed(message: string): never { throw new HttpError(409, 'MATERIAL_BAR_QUALITY_CHANGED', message); }

/** Depreciation removes usable capacity, never physical length. It must name
 * the affected bars and cannot quietly invalidate another OF's reservation. */
export function planMaterialBarQuality(stock: MaterialBarMovementStock, quantityMm: number, command: MaterialBarQualityCommand) {
  if (stock.status !== 'CONFIRMED' || stock.version !== command.expectedVersion)
    changed('Actualisez et confirmez les barres de ce lot avant la décision qualité.');
  const inventory = reconcileMaterialBars({ bars: stock.bars, holds: stock.holds, batches: [stock.batch], reservations: stock.reservations });
  const quantity = milli(quantityMm), selected = new Set<string>();
  if (!quantity || !command.bars.length || command.bars.length > 1000)
    throw new HttpError(422, 'MATERIAL_BAR_QUALITY_INVALID', 'Sélectionnez les barres et une longueur positive.');
  const changes = command.bars.map(selection => {
    const bar = stock.bars.find(item => item.id === selection.barId), amount = milli(selection.quantityMm);
    if (!bar || selected.has(selection.barId) || bar.version !== selection.expectedVersion || !amount)
      changed('Une barre a changé ou figure deux fois dans la décision.');
    selected.add(bar.id);
    const depreciation = milli(bar.depreciatedMm ?? 0) + amount;
    if (depreciation + (inventory.heldByBar.get(bar.id) ?? 0) > milli(bar.lengthMm))
      changed('La longueur dépréciée dépasse la matière libre de cette barre. Réaffectez les réservations concernées.');
    return { bar, depreciatedMm: depreciation / 1000, quantityMm: amount / 1000, nextVersion: bar.version + 1 };
  });
  if (changes.reduce((sum, item) => sum + milli(item.quantityMm), 0) !== quantity)
    throw new HttpError(422, 'MATERIAL_BAR_QUALITY_INVALID', 'Le total des longueurs doit correspondre à la décision qualité.');
  return { quantityMm, changes };
}
