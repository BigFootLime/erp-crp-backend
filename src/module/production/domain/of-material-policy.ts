import { HttpError } from '../../../utils/httpError';
import { quantity } from './of-material';

export type MaterialOriginPolicy = {
  critical: boolean;
  maximumLots: 1 | 2;
  usedOrigins: string[];
  originsByLot: Record<string, string[]>;
};

/** Remnants retain their original heat/lot. Stock locations and bars do not
 * create additional origins; consumed origins remain committed for the OF. */
export function assertMaterialOriginLimit(policy: MaterialOriginPolicy, lotIds: readonly string[]) {
  const origins = new Set(policy.usedOrigins);
  for (const id of lotIds) {
    const roots = policy.originsByLot[id];
    if (!roots?.length) throw new HttpError(409, 'MATERIAL_ORIGIN_UNRESOLVED',
      'L’origine matière de ce lot ne peut pas être établie. Faites vérifier sa traçabilité.', { lotId: id });
    roots.forEach(root => origins.add(root));
  }
  if (origins.size > policy.maximumLots) throw new HttpError(409, 'MATERIAL_LOT_LIMIT',
    policy.critical ? 'Pièce critique : un seul lot matière est autorisé pour tout l’OF.'
      : 'Deux lots matière maximum sont autorisés pour tout l’OF. Préparez un autre OF pour le lot supplémentaire.',
    { maximumLots: policy.maximumLots, origins: [...origins].sort(), critical: policy.critical });
  return [...origins].sort();
}

export type PhysicalMaterialNeed = {
  key: string; designation: string; unit: string | null; required: number;
  consumed: number; usableReserved: number; blockers: readonly string[];
};
export function missingPhysicalMaterial(needs: readonly PhysicalMaterialNeed[]) {
  return needs.flatMap(need => {
    const missing = quantity(Math.max(0, need.required - need.consumed - need.usableReserved));
    return missing > 0 || need.blockers.length ? [{ key: need.key, designation: need.designation,
      unit: need.unit, required: need.required, consumed: need.consumed,
      usableReserved: need.usableReserved, missing, blockers: [...need.blockers] }] : [];
  });
}
