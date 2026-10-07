/** SQL responses for explicitly declared, ordinary OF/need fixture ownership.
 * Keep the real origin guard active in receipt and coverage repository tests. */
export function materialOriginQueryFixture(
  sql: string,
  params: readonly unknown[],
  needOwners: Readonly<Record<string, number>>,
  heldLotIds: readonly string[] = [],
): { rows: Record<string, unknown>[] } | undefined {
  if (sql.startsWith('SELECT need_kind,of_id::text FROM public.of_material_needs')) {
    const owner = needOwners[String(params[0])];
    return { rows: owner === undefined ? [] : [{ need_kind: 'MATIERE', of_id: String(owner) }] };
  }
  if (sql.includes('AS critical') && sql.includes('FROM public.ordres_fabrication o')) {
    const declaredOfIds = new Set(Object.values(needOwners));
    const ids = params[0] as number[];
    return { rows: ids.filter(id => declaredOfIds.has(id)).map(() => ({ critical: false })) };
  }
  if (sql.startsWith('SELECT DISTINCT r.lot_id::text')) return { rows: heldLotIds.map(lot_id => ({ lot_id })) };
  if (sql.startsWith('WITH RECURSIVE ancestry(lot_id,ancestor_id)')) {
    return { rows: (params[0] as string[]).map(lot_id => ({ lot_id, origin_id: lot_id })) };
  }
  return undefined;
}
