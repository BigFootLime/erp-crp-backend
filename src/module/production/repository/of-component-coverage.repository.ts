import type { PoolClient } from 'pg';
import pool from '../../../config/database';
import { HttpError } from '../../../utils/httpError';
import { materialPropertiesFingerprint } from '../domain/of-material';
import { readOperationalLotQualityEligibility } from '../../qualite/repository/quality-operational-gate.repository';

type Db = Pick<PoolClient, 'query'>;
type Requirement = {
  id: string; kind: string; status: string; action: string; path: string;
  articleId: string | null; pieceId: string | null; label: string; unit: string | null;
  childOfId: number | null; childNumber: string | null; childStatus: string | null;
  required: number; updatedAt: string;
};
type Reservation = {
  id: string; requirementId: string; lotId: string | null; lotCode: string | null;
  scope: string | null; quantity: number; physical: boolean | null; updatedAt: string;
};

/** Read the same physical component gate before preparation and before start.
 * Expected child production is shown separately; it never counts as released stock. */
export async function readOfComponentCoverageTx(tx: Db, ofId: number, requireDefined?: boolean) {
  const of = (await tx.query<{ number: string; assembly: boolean; producerId: number | null }>(`
    SELECT o.numero AS number,
      (COALESCE(v.manufacturing_mode='ASSEMBLY',false) OR EXISTS(
        SELECT 1 FROM jsonb_array_elements(COALESCE(o.technical_snapshot->'operations','[]')) op
        WHERE op->>'type_operation'='ASSEMBLAGE')) AS assembly,
      (SELECT c.producer_of_id::bigint::int FROM public.production_consolidation_allocations a
       JOIN public.production_consolidations c ON c.id=a.consolidation_id
       WHERE a.source_of_id=o.id AND a.state='ACTIVE' AND c.state='ACTIVE') AS "producerId"
    FROM public.ordres_fabrication o LEFT JOIN public.piece_technique_versions v
      ON v.id=COALESCE(o.piece_technique_version_id,NULLIF(o.technical_preparation->>'selected_version_id','')::uuid,
        NULLIF(o.technical_preparation->>'selected_draft_version_id','')::uuid)
    WHERE o.id=$1`, [ofId])).rows[0];
  if (!of) throw new HttpError(404, 'OF_NOT_FOUND', 'OF introuvable.');
  const requirements = (await tx.query<Requirement>(`
    SELECT n.id::text,n.component_kind AS kind,n.status,n.action,n.structure_path AS path,
      n.component_article_id::text AS "articleId",n.component_piece_technique_id::text AS "pieceId",
      COALESCE(p.designation,a.designation,p.code_piece,a.code,n.structure_path) AS label,a.unite AS unit,
      child.id::bigint::int AS "childOfId",child.numero AS "childNumber",child.statut::text AS "childStatus",
      n.required_qty::float8 AS required,n.updated_at::text AS "updatedAt"
    FROM public.of_component_requirements n LEFT JOIN public.articles a ON a.id=n.component_article_id
    LEFT JOIN public.pieces_techniques p ON p.id=n.component_piece_technique_id
    LEFT JOIN public.ordres_fabrication child ON child.id=n.component_of_id
    WHERE n.consuming_of_id=$1 AND n.status<>'CANCELLED' ORDER BY n.structure_path,n.id`, [ofId])).rows;
  const reservations = (await tx.query<Reservation>(`
    SELECT r.id::text,r.of_component_requirement_id::text AS "requirementId",r.lot_id::text AS "lotId",
      l.lot_code AS "lotCode",r.source_scope AS scope,GREATEST(0,r.qty_reserved-r.qty_consumed)::float8 AS quantity,
      (l.lot_status='LIBERE' AND b.qty_total-b.qty_depreciated>=b.qty_reserved AND r.article_id=l.article_id) AS physical,
      r.updated_at::text AS "updatedAt"
    FROM public.stock_reservations r JOIN public.of_component_requirements n ON n.id=r.of_component_requirement_id
    LEFT JOIN public.stock_batches b ON b.id=r.stock_batch_id LEFT JOIN public.lots l ON l.id=r.lot_id
    WHERE n.consuming_of_id=$1 AND n.status NOT IN ('CANCELLED','CONSUMED') AND r.status='ACTIVE'
      AND(r.expires_at IS NULL OR r.expires_at>statement_timestamp()) ORDER BY r.lot_id,r.id`, [ofId])).rows;
  const quality = new Map<string, Awaited<ReturnType<typeof readOperationalLotQualityEligibility>>>();
  for (const r of reservations) {
    if (!r.lotId || !r.physical || quality.has(r.lotId)) continue;
    quality.set(r.lotId, await readOperationalLotQualityEligibility({client:tx,lotId:r.lotId,qty:0,purpose:'RESERVE'}));
  }
  const items = requirements.map(n => {
    const lots = reservations.filter(r => r.requirementId === n.id).map(r => {
      const blocks = !r.lotId || !r.physical
        ? ['Le lot réservé ne dispose pas du stock physique libéré attendu.']
        : (quality.get(r.lotId)?.eligibility.blocks ?? []).map(b => b.message);
      return {...r, usable:blocks.length ? 0 : r.quantity, blockers:blocks};
    });
    const reserved = lots.reduce((sum,r) => sum+r.quantity,0), usable = lots.reduce((sum,r) => sum+r.usable,0);
    const consumed = n.status === 'CONSUMED';
    const missing = consumed ? 0 : Math.max(0,n.required-usable);
    const blockers = [...new Set(lots.flatMap(r => r.blockers))];
    return {...n,reserved,usable,missing,consumed,lots,blockers,
      ready:consumed || (reserved>=n.required && usable>=n.required && !blockers.length)};
  });
  const assembly = requireDefined ?? of.assembly;
  const definitionMissing = assembly && !items.length;
  const ready = !definitionMissing && items.every(n => n.ready);
  const version = materialPropertiesFingerprint({ofId,of,requirements,reservations,
    quality:[...quality].map(([id,q])=>[id,q.target,q.already_committed_qty,q.eligibility]),ready});
  return {ofId,number:of.number,assembly,coveredByOfId:of.producerId,definitionMissing,ready,version,items};
}

export async function getOfComponentCoverage(ofId: number) {
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const state = await readOfComponentCoverageTx(tx,ofId);
    await tx.query('COMMIT');
    return state;
  } catch (error) { await tx.query('ROLLBACK'); throw error; }
  finally { tx.release(); }
}
