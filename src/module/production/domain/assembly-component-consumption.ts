import { HttpError } from '../../../utils/httpError';

type Lot = { id: string; lotId: string | null; lotCode: string | null; rowVersion: number; usable: number; quantity: number };
type Requirement = {
  id: string; label: string; sourceOfId: number; required: number; consumedQuantity: number;
  quantityPerParent: string; parentVersionId: string; unit: string | null; lots: Lot[];
};
export type AssemblyCoverage = {
  ofId: number; quantity: number; versionId: string | null; ready: boolean; definitionMissing: boolean;
  coveredByOfId: number | null; items: Requirement[];
};

const MICRO = 1_000_000n;
function scaled(value: string | number, digits: number): bigint {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(String(value));
  if (!match || (match[2]?.length ?? 0) > digits) {
    throw new HttpError(422, 'ASSEMBLY_QUANTITY_PRECISION', 'La nomenclature doit utiliser une quantité représentable dans l’unité stock.');
  }
  return BigInt(match[1]) * 10n ** BigInt(digits) + BigInt((match[2] ?? '').padEnd(digits, '0'));
}
function units(milli: bigint): number {
  if (milli > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new HttpError(422, 'ASSEMBLY_QUANTITY_LIMIT', 'La quantité de composants dépasse la précision stock autorisée.');
  }
  return Number(milli) / 1000;
}
function parentCount(childMilli: bigint, perParent: bigint): bigint {
  if (!perParent || (childMilli * MICRO) % perParent !== 0n) {
    throw new HttpError(409, 'ASSEMBLY_COMPONENT_BALANCE_UNKNOWN', 'Les quantités de composants ne correspondent pas à des ensembles complets. Rapprochez leurs sorties.');
  }
  const result = childMilli * MICRO / perParent;
  if (result % 1000n !== 0n) {
    throw new HttpError(409, 'ASSEMBLY_COMPONENT_BALANCE_UNKNOWN', 'La quantité mise en montage doit représenter des pièces entières.');
  }
  return result;
}

/** Requirements transferred by consolidation still belong to their source OF.
 * Allocate whole assemblies to one source at a time; never spread fractional
 * components proportionally across source orders. */
function analyzeAssemblyComponents(coverage: AssemblyCoverage) {
  if (coverage.coveredByOfId) {
    throw new HttpError(409, 'ASSEMBLY_PRODUCER_REQUIRED', 'Préparez la sortie depuis l’OF qui réalise le montage.', { producerOfId: coverage.coveredByOfId });
  }
  if (coverage.definitionMissing || !coverage.items.length || !coverage.versionId) {
    throw new HttpError(409, 'ASSEMBLY_COMPONENT_DEFINITION_REQUIRED', 'Validez la nomenclature du dossier de montage.');
  }
  const groups = new Map<number, { target: bigint; consumed: bigint; requirements: Requirement[] }>();
  for (const item of coverage.items) {
    if (item.parentVersionId !== coverage.versionId || !item.unit) {
      throw new HttpError(409, 'ASSEMBLY_COMPONENT_VERSION_CHANGED', 'La version ou l’unité des composants ne correspond pas au dossier validé.');
    }
    const perParent = scaled(item.quantityPerParent, 6);
    const target = parentCount(scaled(item.required, 3), perParent);
    const consumed = parentCount(scaled(item.consumedQuantity, 3), perParent);
    if (consumed > target) throw new HttpError(409, 'ASSEMBLY_COMPONENT_OVERCONSUMED', 'Les sorties de composants dépassent le besoin figé.');
    const group = groups.get(item.sourceOfId);
    if (group && (group.target !== target || group.consumed !== consumed)) {
      throw new HttpError(409, 'ASSEMBLY_COMPONENT_BALANCE_UNKNOWN', 'Les sorties des sous-pièces d’un même OF doivent couvrir la même quantité montée.');
    }
    if (group) group.requirements.push(item);
    else groups.set(item.sourceOfId, { target, consumed, requirements: [item] });
  }
  const sources = [...groups].sort(([left], [right]) => left - right);
  const target = sources.reduce((sum, [, group]) => sum + group.target, 0n);
  if (target !== scaled(coverage.quantity, 3)) {
    throw new HttpError(409, 'ASSEMBLY_COMPONENT_TARGET_CHANGED', 'Les besoins de composants ne couvrent pas exactement la quantité de l’OF. Actualisez la nomenclature.');
  }
  const consumed = sources.reduce((sum, [, group]) => sum + group.consumed, 0n);
  const remaining = target - consumed;
  return { sources, target, consumed, remaining };
}

/** Physical intake only: quantity declarations and pointage never contribute.
 * A fully withdrawn OF retains its exact balance even with no new issue plan. */
export function getAssemblyComponentBalance(coverage: AssemblyCoverage) {
  const { sources, target, consumed, remaining } = analyzeAssemblyComponents(coverage);
  return { quantity: units(target), alreadyInAssembly: units(consumed), remaining: units(remaining),
    sourceBalances: sources.map(([sourceOfId, group]) => ({ sourceOfId, quantity: units(group.target),
      alreadyInAssembly: units(group.consumed), remaining: units(group.target - group.consumed) })) };
}

export function planAssemblyComponentConsumption(coverage: AssemblyCoverage, requested?: number) {
  const { sources, consumed, remaining } = analyzeAssemblyComponents(coverage);
  const requestedMilli = requested === undefined ? remaining : scaled(requested, 3);
  if (requestedMilli % 1000n !== 0n || requestedMilli <= 0n || requestedMilli > remaining) {
    throw new HttpError(422, 'ASSEMBLY_QUANTITY_EXCEEDED', 'Choisissez une quantité entière dans le reliquat à mettre en montage.');
  }
  // Whole-OF physical coverage remains mandatory, even for a partial intake.
  if (!coverage.ready) throw new HttpError(409, 'ASSEMBLY_COMPONENTS_NOT_READY', 'Réservez tous les composants libérés avant le montage.');
  const allocations: Array<{ requirementId: string; sourceOfId: number; label: string; unit: string;
    reservationId: string; reservationVersion: number; lotId: string; lotCode: string | null; quantity: number }> = [];
  const sourceAllocations: Array<{ sourceOfId: number; assemblyQuantity: number }> = [];
  let toAllocate = requestedMilli;
  for (const [sourceOfId, group] of sources) {
    const count = toAllocate < group.target - group.consumed ? toAllocate : group.target - group.consumed;
    if (count <= 0n) continue;
    sourceAllocations.push({ sourceOfId, assemblyQuantity: units(count) });
    for (const item of group.requirements) {
      const product = count * scaled(item.quantityPerParent, 6);
      if (product % MICRO !== 0n) throw new HttpError(422, 'ASSEMBLY_QUANTITY_PRECISION', 'Cette quantité montée produit un besoin non représentable en stock.');
      let required = product / MICRO;
      for (const lot of [...item.lots].sort((left, right) => (left.lotId ?? '').localeCompare(right.lotId ?? '') || left.id.localeCompare(right.id))) {
        if (!lot.lotId || lot.usable <= 0) continue;
        const available = scaled(Math.min(lot.quantity, lot.usable), 3);
        const take = required < available ? required : available;
        if (take > 0n) allocations.push({ requirementId: item.id, sourceOfId, label: item.label, unit: item.unit!,
          reservationId: lot.id, reservationVersion: lot.rowVersion, lotId: lot.lotId, lotCode: lot.lotCode, quantity: units(take) });
        required -= take;
        if (!required) break;
      }
      if (required > 0n) throw new HttpError(409, 'ASSEMBLY_COMPONENTS_NOT_READY', 'Une sous-pièce manque dans les réservations libérées.', { requirementId: item.id });
    }
    toAllocate -= count;
    if (!toAllocate) break;
  }
  return { quantity: units(requestedMilli), alreadyInAssembly: units(consumed), remainingBefore: units(remaining),
    remainingAfter: units(remaining - requestedMilli), sourceAllocations, allocations };
}
