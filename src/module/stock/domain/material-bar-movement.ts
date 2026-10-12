import { HttpError } from '../../../utils/httpError';
import { reconcileMaterialBars, type MaterialBar, type MaterialBarHold } from './material-bars';
import { receivedMaterialBarLengths, type ReceivedBarGroup } from './material-bar-receipt';

/** The repository supplies a locked snapshot, never a client-provided balance. */
export type MaterialBarMovementStock = {
  version: string;
  status: 'CONFIRMED' | 'UNCONFIRMED' | 'REVIEW_REQUIRED';
  batch: { id: string; articleId: string; lotId: string; physicalMm: number; reservedMm: number };
  bars: readonly MaterialBar[];
  holds: readonly MaterialBarHold[];
  reservations: ReadonlyArray<{ id: string; batchId: string; remainingMm: number }>;
};
export type MaterialBarSelection = { barId: string; expectedVersion: number };
export type MaterialBarMovementCommand =
  | { kind: 'RECEIVE'; expectedVersion: string; bars: readonly ReceivedBarGroup[] }
  | { kind: 'ISSUE'; expectedVersion: string; bars: ReadonlyArray<MaterialBarSelection & { quantityMm: number }> }
  | { kind: 'TRANSFER'; expectedVersion: string; expectedDestinationVersion: string; bars: readonly MaterialBarSelection[] };

function invalid(message: string): never { throw new HttpError(422, 'MATERIAL_BAR_MOVEMENT_INVALID', message); }
function changed(message: string): never { throw new HttpError(409, 'MATERIAL_BAR_MOVEMENT_CHANGED', message); }
function milli(value: number): number {
  const result = Math.round(value * 1000);
  if (!Number.isFinite(value) || value < 0 || value > 1e9 || Math.abs(result - value * 1000) > 1e-6)
    invalid('La longueur doit être positive ou nulle, avec trois décimales maximum.');
  return result;
}

function verifyStock(stock: MaterialBarMovementStock, expected: string, allowEmpty: boolean) {
  if (stock.version !== expected) changed('Le stock ou ses réservations ont changé. Actualisez les barres.');
  const empty = stock.status === 'UNCONFIRMED' && stock.batch.physicalMm === 0 && stock.batch.reservedMm === 0
    && !stock.bars.length && !stock.holds.length && !stock.reservations.length;
  if (stock.status !== 'CONFIRMED' && !(allowEmpty && empty))
    changed('Confirmez les barres déjà présentes dans cet emplacement.');
  return reconcileMaterialBars({ bars: stock.bars, holds: stock.holds, batches: [stock.batch], reservations: stock.reservations });
}

/** Normal stock moves cannot infer geometry, consume an OF's reservation or cut
 * a bar implicitly while transferring it. The transaction retains bar IDs and
 * their original lengths; only their current location/version changes. */
export function planMaterialBarMovement(input: {
  source: MaterialBarMovementStock;
  destination?: MaterialBarMovementStock;
  quantityMm: number;
  command: MaterialBarMovementCommand;
}) {
  const { source, destination, command } = input;
  const quantity = milli(input.quantityMm);
  if (quantity <= 0) invalid('La quantité du mouvement doit être strictement positive.');
  const reconciled = verifyStock(source, command.expectedVersion, command.kind === 'RECEIVE');
  if (command.kind === 'RECEIVE') {
    const lengths = receivedMaterialBarLengths(command.bars, input.quantityMm);
    milli((milli(source.batch.physicalMm) + quantity) / 1000);
    return { kind: 'RECEIVE' as const, batchId: source.batch.id, quantityMm: input.quantityMm, lengths };
  }
  if (!command.bars.length || command.bars.length > 1000) invalid('Sélectionnez entre 1 et 1 000 barres.');
  const available = new Map(source.bars.map(bar => [bar.id, bar]));
  const selected = new Set<string>();
  const changes: Array<{ bar: MaterialBar; quantityMm: number; remainingMm: number; nextVersion: number }> = [];
  let total = 0;
  for (const selection of command.bars) {
    if (selected.has(selection.barId)) invalid('Une barre ne peut figurer qu’une fois dans le mouvement.');
    selected.add(selection.barId);
    const bar = available.get(selection.barId);
    if (!bar || bar.batchId !== source.batch.id || bar.version !== selection.expectedVersion)
      changed('Une barre a changé ou ne se trouve plus dans cet emplacement.');
    const length = milli(bar.lengthMm), held = reconciled.heldByBar.get(bar.id) ?? 0;
    const amount = command.kind === 'ISSUE' ? milli((selection as MaterialBarSelection & { quantityMm: number }).quantityMm) : length;
    if (amount <= 0 || amount > length) invalid('La longueur sortie dépasse la barre sélectionnée ou est nulle.');
    if (amount > length - held)
      changed(command.kind === 'TRANSFER'
        ? 'Cette barre est réservée à un OF. Réaffectez sa réservation avant de la déplacer.'
        : 'La sortie utiliserait de la matière réservée à un OF. Sélectionnez une longueur libre.');
    total += amount;
    if (total > quantity) invalid('Les barres sélectionnées dépassent la quantité du mouvement.');
    changes.push({ bar, quantityMm: amount / 1000, remainingMm: (length - amount) / 1000, nextVersion: bar.version + 1 });
  }
  if (total !== quantity) invalid('Les longueurs sélectionnées doivent correspondre exactement au mouvement.');
  if (command.kind === 'ISSUE') return { kind: 'ISSUE' as const, batchId: source.batch.id, quantityMm: input.quantityMm, changes };
  if (!destination || destination.batch.id === source.batch.id) invalid('Choisissez un autre emplacement pour le transfert.');
  if (source.batch.articleId !== destination.batch.articleId || source.batch.lotId !== destination.batch.lotId)
    invalid('Un transfert conserve l’article et le lot matière d’origine.');
  verifyStock(destination, command.expectedDestinationVersion, true);
  milli((milli(destination.batch.physicalMm) + quantity) / 1000);
  if (destination.bars.some(bar => selected.has(bar.id))) changed('Une barre sélectionnée existe déjà à destination.');
  return { kind: 'TRANSFER' as const, sourceBatchId: source.batch.id, destinationBatchId: destination.batch.id,
    quantityMm: input.quantityMm, bars: changes.map(change => ({ ...change.bar, batchId: destination.batch.id, version: change.nextVersion })) };
}

export type MaterialBarMovementPlan = ReturnType<typeof planMaterialBarMovement>;
