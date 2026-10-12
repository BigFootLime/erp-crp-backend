import { HttpError } from '../../../utils/httpError';

export type MaterialBar = {
  id: string;
  batchId: string;
  lengthMm: number;
  version: number;
};
export type MaterialBarHold = { barId: string; reservationId: string; remainingMm: number };
export type MaterialBarAllocation = { barId: string; batchId: string; expectedVersion: number; quantityMm: number };

const units = (value: number) => {
  const n = Math.round(value * 1000);
  if (!Number.isFinite(value) || value < 0 || value > 1e9 || Math.abs(value * 1000 - n) > 1e-6)
    throw new HttpError(422, 'MATERIAL_BAR_LENGTH_INVALID', 'La longueur doit être positive ou nulle, avec trois décimales maximum.');
  return n;
};
const conflict = (message: string): never => { throw new HttpError(409, 'MATERIAL_BAR_INVENTORY_CHANGED', message); };

/** Geometry supplements, but never replaces, canonical stock and reservations.
 * Every caller must pass locked, reconciled inventory. Unknown bars are not inferred. */
export function reconcileMaterialBars(input: {
  bars: readonly MaterialBar[];
  holds: readonly MaterialBarHold[];
  batches: ReadonlyArray<{ id: string; physicalMm: number; reservedMm: number }>;
  reservations: ReadonlyArray<{ id: string; batchId: string; remainingMm: number }>;
}) {
  const bars = new Map<string, MaterialBar>(), batchLengths = new Map<string, number>();
  const batches = new Map<string, { physical: number; reserved: number }>();
  const reservations = new Map<string, { batchId: string; remaining: number }>();
  for (const batch of input.batches) {
    if (batches.has(batch.id)) conflict('Un emplacement matière est présent deux fois.');
    const physical = units(batch.physicalMm), reserved = units(batch.reservedMm);
    if (reserved > physical) conflict('Les réservations dépassent le stock physique.');
    batches.set(batch.id, { physical, reserved });
  }
  for (const bar of input.bars) {
    if (!bar.id || bars.has(bar.id) || !batches.has(bar.batchId) || !Number.isSafeInteger(bar.version) || bar.version < 1)
      conflict('Une barre est dupliquée ou ne correspond plus à son stock.');
    bars.set(bar.id, bar);
    batchLengths.set(bar.batchId, (batchLengths.get(bar.batchId) ?? 0) + units(bar.lengthMm));
  }
  const batchReservations = new Map<string, number>();
  for (const reservation of input.reservations) {
    if (!reservation.id || reservations.has(reservation.id) || !batches.has(reservation.batchId))
      conflict('Une réservation est dupliquée ou ne correspond plus à son stock.');
    const remaining = units(reservation.remainingMm);
    reservations.set(reservation.id, { batchId: reservation.batchId, remaining });
    batchReservations.set(reservation.batchId, (batchReservations.get(reservation.batchId) ?? 0) + remaining);
  }
  const heldByBar = new Map<string, number>(), heldByReservation = new Map<string, number>(), pairs = new Set<string>();
  for (const hold of input.holds) {
    const bar = bars.get(hold.barId), reservation = reservations.get(hold.reservationId);
    const key = `${hold.barId}:${hold.reservationId}`;
    if (!bar || !reservation || bar.batchId !== reservation.batchId || pairs.has(key))
      conflict('Une affectation ne correspond plus à sa barre ou à sa réservation.');
    pairs.add(key);
    const held = units(hold.remainingMm);
    heldByBar.set(hold.barId, (heldByBar.get(hold.barId) ?? 0) + held);
    heldByReservation.set(hold.reservationId, (heldByReservation.get(hold.reservationId) ?? 0) + held);
  }
  for (const [id, bar] of bars) if ((heldByBar.get(id) ?? 0) > units(bar.lengthMm))
    conflict('La longueur réservée dépasse une barre physique.');
  for (const [id, reservation] of reservations) if ((heldByReservation.get(id) ?? 0) !== reservation.remaining)
    conflict('Rapprochez les barres avec les réservations existantes.');
  for (const [id, batch] of batches) {
    if ((batchLengths.get(id) ?? 0) !== batch.physical) conflict('Confirmez les barres réelles : leurs longueurs ne correspondent plus au stock.');
    if ((batchReservations.get(id) ?? 0) !== batch.reserved) conflict('Rapprochez les réservations avec le stock avant de préparer la découpe.');
  }
  return { bars: input.bars, holds: input.holds, heldByBar };
}

/** Allocate whole blanks on real bars in caller-supplied FIFO order. Existing
 * holds for this same need may combine on one bar, never across bar boundaries. */
export function proposeMaterialBarAllocation(input: {
  inventory: ReturnType<typeof reconcileMaterialBars>;
  reservationIds: readonly string[];
  requiredBlanks: number;
  blankLengthMm: number;
  kerfMm: number;
  maximumAdditionalMm?: number;
  availableMmByBar?: ReadonlyMap<string, number>;
}) {
  if (!Number.isSafeInteger(input.requiredBlanks) || input.requiredBlanks < 0 || input.requiredBlanks > 1e9)
    throw new HttpError(422, 'MATERIAL_BAR_BLANK_COUNT_INVALID', 'La quantité de bruts doit être entière, positive ou nulle.');
  const blank = units(input.blankLengthMm), step = blank + units(input.kerfMm);
  if (!blank) throw new HttpError(422, 'MATERIAL_BAR_LENGTH_INVALID', 'La longueur du brut doit être supérieure à zéro.');
  const owned = new Set(input.reservationIds), heldByBar = new Map<string, number>();
  for (const hold of input.inventory.holds) if (owned.has(hold.reservationId))
    heldByBar.set(hold.barId, (heldByBar.get(hold.barId) ?? 0) + units(hold.remainingMm));
  const usableHeldBlanks = [...heldByBar.values()].reduce((sum, held) => sum + Math.floor(held / step), 0);
  let missing = Math.max(0, input.requiredBlanks - usableHeldBlanks);
  let budget = input.maximumAdditionalMm === undefined ? Infinity : units(input.maximumAdditionalMm);
  const planned = new Map<string, MaterialBarAllocation>(), freeByBar = new Map<string, number>();
  for (const bar of input.inventory.bars) {
    const physicalFree = units(bar.lengthMm) - (input.inventory.heldByBar.get(bar.id) ?? 0);
    const proposedFree = input.availableMmByBar?.get(bar.id);
    freeByBar.set(bar.id, Math.min(physicalFree, proposedFree === undefined ? Infinity : units(proposedFree)));
  }
  const take = (bar: MaterialBar, length: number, blanks: number) => {
    const previous = planned.get(bar.id);
    planned.set(bar.id, { barId: bar.id, batchId: bar.batchId, expectedVersion: bar.version,
      quantityMm: ((previous ? units(previous.quantityMm) : 0) + length) / 1000 });
    freeByBar.set(bar.id, (freeByBar.get(bar.id) ?? 0) - length);
    budget -= length;
    missing -= blanks;
  };
  // Finish existing partial blanks first, cheapest top-up first. Otherwise a
  // tight quality/location budget could buy one blank while two are possible.
  const partials = [...input.inventory.bars].sort((a, b) => (heldByBar.get(b.id) ?? 0) % step - (heldByBar.get(a.id) ?? 0) % step);
  for (const bar of partials) {
    if (!missing) break;
    const remainder = (heldByBar.get(bar.id) ?? 0) % step, topup = step - remainder;
    if (remainder && topup <= Math.min(budget, freeByBar.get(bar.id) ?? 0)) take(bar, topup, 1);
  }
  // Remaining full blanks use the physical FIFO order, without joining bars.
  for (const bar of input.inventory.bars) {
    if (!missing) break;
    const blanks = Math.min(missing, Math.floor(Math.min(budget, freeByBar.get(bar.id) ?? 0) / step));
    if (blanks > 0) take(bar, blanks * step, blanks);
  }
  return { usableHeldBlanks, allocations: [...planned.values()], missingBlanks: missing };
}

/** Physical closure cannot eat another OF's hold. Warnings remain confirmable;
 * compensation must recheck the returned bar version before restoring a shape. */
export function consumeMaterialBar(input: {
  bar: MaterialBar;
  expectedVersion: number;
  cutMm: number;
  discardedMm: number;
  close: boolean;
  acknowledgedLargeRemainder: boolean;
  heldByOtherNeedsMm: number;
}) {
  if (input.expectedVersion !== input.bar.version) conflict('Cette barre a changé. Relisez sa longueur avant de couper.');
  const length = units(input.bar.lengthMm), cut = units(input.cutMm), discarded = units(input.discardedMm), other = units(input.heldByOtherNeedsMm);
  if (!cut || cut + discarded > length || (!input.close && discarded > 0))
    throw new HttpError(422, 'MATERIAL_BAR_DEBIT_INVALID', 'Vérifiez la longueur coupée et le reliquat de cette barre.');
  if (input.close && cut + discarded !== length)
    throw new HttpError(422, 'MATERIAL_BAR_CLOSURE_INCOMPLETE', 'Le solde doit inclure toute la longueur restante de la barre.');
  if (length - cut - discarded < other) conflict('Cette barre conserve une quantité réservée à un autre besoin.');
  if (discarded > 150000 && !input.acknowledgedLargeRemainder)
    throw new HttpError(409, 'MATERIAL_BAR_CLOSURE_WARNING', 'Le reliquat dépasse 150 mm. Confirmez son solde pour continuer.');
  return { remainingMm: (length - cut - discarded) / 1000, nextVersion: input.bar.version + 1 };
}
