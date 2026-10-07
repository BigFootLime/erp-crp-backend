import { HttpError } from '../../../utils/httpError';
import { quantity, type DebitRule } from './of-material';

/** An observed yield belongs to one material need/source, never to a length ratio.
 * A single source is unambiguous for clients predating the explicit yield input. */
export function materialSourceYields(input: {
  rule: DebitRule;
  good: number;
  scrap: number;
  varianceReason?: string | null;
  sources: Array<{ id: string; quantity: number; yield?: { good: number; scrap: number } }>;
}) {
  const count = (value: number) => Number.isSafeInteger(value) && value >= 0 && value <= 1e9;
  if (!count(input.good) || !count(input.scrap) || !input.sources.length ||
      new Set(input.sources.map(s => s.id)).size !== input.sources.length)
    throw new HttpError(422, 'MATERIAL_SOURCE_YIELD_INVALID', 'Vérifiez les quantités de bruts et leurs lots sources.');

  const yields = input.sources.map(source => {
    const observed = source.yield ?? (input.sources.length === 1 ? { good: input.good, scrap: input.scrap } : null);
    if (!observed)
      throw new HttpError(422, 'MATERIAL_SOURCE_YIELD_REQUIRED', 'Indiquez les bruts bons et rebutés obtenus sur chaque lot matière.');
    if (!count(observed.good) || !count(observed.scrap) || !Number.isFinite(source.quantity) || source.quantity <= 0)
      throw new HttpError(422, 'MATERIAL_SOURCE_YIELD_INVALID', 'Chaque quantité de bruts par lot doit être entière, positive ou nulle.');
    return { id: source.id, good: observed.good, scrap: observed.scrap, quantity: source.quantity };
  });
  if (yields.reduce((sum, s) => sum + s.good, 0) !== input.good ||
      yields.reduce((sum, s) => sum + s.scrap, 0) !== input.scrap)
    throw new HttpError(422, 'MATERIAL_SOURCE_YIELD_TOTAL_MISMATCH', 'Les bruts bons et rebutés de chaque besoin matière doivent correspondre aux totaux du débit.');

  for (const source of yields) {
    const expected = quantity((source.good + source.scrap) * (input.rule.unitsPerBlank + input.rule.kerfPerBlank));
    if (quantity(source.quantity) === expected) continue;
    if (input.rule.form === 'UNIT')
      throw new HttpError(422, 'MATERIAL_SOURCE_YIELD_CONVERSION_MISMATCH', 'Les bruts unitaires déclarés par lot ne correspondent pas aux unités prélevées.');
    if ((input.varianceReason?.trim().length ?? 0) < 10)
      throw new HttpError(422, 'MATERIAL_SOURCE_YIELD_VARIANCE_REQUIRED', 'Expliquez les écarts de rendement par lot par rapport à la règle de débit (10 caractères minimum).');
  }
  return yields.map(({ id, good, scrap }) => ({ id, good, scrap }));
}
