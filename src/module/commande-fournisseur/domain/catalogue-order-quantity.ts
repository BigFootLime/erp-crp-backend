import { HttpError } from '../../../utils/httpError';

export type CatalogueQuantityLine = {
  catalogue_id?: string | null; article_id?: string | null; unite?: string | null; quantite: number; qty_annulee?: number | null;
};
/** Caller supplies only lines from one supplier order, already isolated by its header. */
export function catalogueQuantityKey(line: CatalogueQuantityLine): string {
  return JSON.stringify([line.catalogue_id ?? null, line.article_id ?? null, line.unite ?? null]);
}
export function catalogueBatchQuantities(lines: readonly CatalogueQuantityLine[]): Map<string, number> {
  const quantities = new Map<string, number>();
  for (const line of lines) {
    if (!line.catalogue_id) continue;
    if (!Number.isFinite(line.quantite) || line.quantite < 0) {
      throw new HttpError(422, 'INVALID_QUANTITY', 'La quantité doit être positive ou nulle.');
    }
    const key = catalogueQuantityKey(line);
    quantities.set(key, (quantities.get(key) ?? 0) + line.quantite);
  }
  return quantities;
}
