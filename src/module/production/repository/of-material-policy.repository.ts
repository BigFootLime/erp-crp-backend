import type { DossierDb } from './of-dossier.repository';
import { HttpError } from '../../../utils/httpError';
import { assertMaterialOriginLimit, type MaterialOriginPolicy } from '../domain/of-material-policy';

export async function readMaterialOriginPolicyTx(tx: DossierDb, ofIds: readonly number[], additionalLotIds: readonly string[] = []): Promise<MaterialOriginPolicy> {
  const rows = (await tx.query<{ critical: boolean }>(`SELECT
    (o.material_origin_limit=1 OR COALESCE(o.technical_snapshot->'piece'->>'piece_critique','false')='true' OR pt.piece_critique) AS critical
    FROM public.ordres_fabrication o JOIN public.pieces_techniques pt ON pt.id=o.piece_technique_id
    WHERE o.id=ANY($1::bigint[])`, [ofIds])).rows;
  if (rows.length !== ofIds.length) throw new HttpError(404, 'OF_NOT_FOUND', 'Ordre de fabrication introuvable.');
  const held = (await tx.query<{ lot_id: string }>(`SELECT DISTINCT r.lot_id::text
    FROM public.stock_reservations r LEFT JOIN public.of_material_needs n ON n.id=r.material_need_id
    WHERE (r.of_id=ANY($1::bigint[]) OR (r.source_type='OF' AND r.source_id=ANY($2::text[])))
      AND r.lot_id IS NOT NULL AND (n.need_kind='MATIERE' OR (r.material_need_id IS NULL
        AND r.of_component_requirement_id IS NULL AND EXISTS(SELECT 1 FROM public.articles_matiere m WHERE m.article_id=r.article_id)))
      AND (r.qty_consumed>0 OR r.status='CONSUMED' OR
        (r.status='ACTIVE' AND r.qty_reserved>r.qty_consumed AND (r.expires_at IS NULL OR r.expires_at>now())))
    ORDER BY 1`, [ofIds, ofIds.map(String)])).rows.map(r => r.lot_id);
  const lotIds = [...new Set([...held, ...additionalLotIds])].sort();
  const ancestry = (await tx.query<{ lot_id: string; origin_id: string }>(`WITH RECURSIVE ancestry(lot_id,ancestor_id) AS (
    SELECT id,id FROM public.lots WHERE id=ANY($1::uuid[])
    UNION SELECT a.lot_id,e.parent_lot_id FROM ancestry a
      JOIN public.stock_lot_genealogy_edges e ON e.child_lot_id=a.ancestor_id
      JOIN public.production_material_remnants r ON r.lot_id=e.child_lot_id AND r.stock_movement_id=e.stock_movement_id
  ) SELECT a.lot_id::text,a.ancestor_id::text AS origin_id FROM ancestry a WHERE NOT EXISTS (
    SELECT 1 FROM public.stock_lot_genealogy_edges e JOIN public.production_material_remnants r
      ON r.lot_id=e.child_lot_id AND r.stock_movement_id=e.stock_movement_id WHERE e.child_lot_id=a.ancestor_id)
    ORDER BY 1,2`, [lotIds])).rows;
  const originsByLot: Record<string, string[]> = {};
  for (const row of ancestry) (originsByLot[row.lot_id] ??= []).push(row.origin_id);
  for (const id of held) if (!originsByLot[id]?.length)
    throw new HttpError(409, 'MATERIAL_ORIGIN_UNRESOLVED', 'Vérifiez la traçabilité des lots matière déjà engagés.', { lotId: id });
  const critical = rows.some(row => row.critical);
  return { critical, maximumLots: critical ? 1 : 2, originsByLot,
    usedOrigins: [...new Set(held.flatMap(id => originsByLot[id]))].sort() };
}

/** Central reservation owner also covers receipt transfers. Lock the OF before
 * stock/quality locks so two simultaneous confirmations cannot add a third lot. */
export async function assertMaterialReservationOriginTx(tx: DossierDb, ofId: number, needId: string, lotId: string | null | undefined) {
  await tx.query('SELECT id FROM public.ordres_fabrication WHERE id=$1 FOR UPDATE', [ofId]);
  const need = (await tx.query<{ need_kind: string; of_id: string }>(
    'SELECT need_kind,of_id::text FROM public.of_material_needs WHERE id=$1::uuid', [needId])).rows[0];
  if (!need || Number(need.of_id) !== ofId) throw new HttpError(409, 'MATERIAL_NEED_NOT_FOUND', 'Ce besoin matière ne correspond plus à cet OF.');
  if (need.need_kind !== 'MATIERE') return;
  if (!lotId) throw new HttpError(409, 'LOT_REQUIRED', 'Choisissez un lot matière traçable.');
  const policy=await readMaterialOriginPolicyTx(tx, [ofId], [lotId]);
  assertMaterialOriginLimit(policy, [lotId]);
  if(policy.critical)await tx.query('UPDATE public.ordres_fabrication SET material_origin_limit=1 WHERE id=$1 AND material_origin_limit<>1',[ofId]);
}
