import type { PoolClient } from 'pg';
import pool from '../../../config/database';
import { HttpError } from '../../../utils/httpError';
import type { RecoveryConsolidationCandidatesQuery } from '../validators/recovery-consolidation.validators';

type Candidate = {
  consolidation_id: string; producer_of_id: number; producer_number: string;
  quantity: number; status: string; cutting_finished: boolean; operation_finished: boolean;
  cutting_missing: boolean;
};

/** Discovery only. Selecting a candidate still requires the full stock, capacity
 * and deadline preview; it never implies that a grouping can be applied. */
export async function readRecoveryGroupingCandidatesTx(
  tx: Pick<PoolClient, 'query'>, recoveryId: string, query: RecoveryConsolidationCandidatesQuery,
) {
  const context = (await tx.query<{ enabled: boolean; status: string; of_status: string; covered: boolean }>(`
    SELECT COALESCE((SELECT enabled FROM public.app_feature_flags WHERE key='PRODUCTION_CONSOLIDATION'),false) AS enabled,
      request.status,recovery_of.statut::text AS of_status,
      EXISTS(SELECT 1 FROM public.production_consolidation_allocations a
        WHERE a.source_of_id=recovery_of.id AND a.state='ACTIVE') AS covered
    FROM public.delivery_urgency_recoveries recovery
    JOIN public.delivery_urgency_requests request ON request.id=recovery.request_id
    JOIN public.ordres_fabrication recovery_of ON recovery_of.id=recovery.recovery_of_id
    WHERE recovery.id=$1::uuid`, [recoveryId])).rows[0];
  if (!context) throw new HttpError(404, 'RECOVERY_NOT_FOUND', 'Récupération introuvable.');
  if (!context.enabled) throw new HttpError(409, 'CONSOLIDATION_DISABLED', 'Le regroupement de production n’est pas activé.');
  if (!['WAITING_PLANNER', 'APPROVED', 'WITHDRAWN'].includes(context.status))
    throw new HttpError(409, 'RECOVERY_CLOSED', 'Cette demande urgente est annulée.');
  if (context.covered || context.of_status !== 'BROUILLON')
    return { items: [], next_cursor: null, available: false, reason: 'Cette récupération est déjà regroupée ou engagée. Conservez son parcours actuel.' };

  const pattern = `%${query.q.replace(/[\\%_]/g, '\\$&')}%`;
  const rows = (await tx.query<Candidate>(`
    SELECT grouping.id::text AS consolidation_id,producer.id::int AS producer_of_id,
      producer.numero AS producer_number,producer.quantite_lancee::float8 AS quantity,producer.statut::text AS status,
      COALESCE(operations.cutting_finished,false) AS cutting_finished,
      COALESCE(operations.operation_finished,false) AS operation_finished,
      (COALESCE(operations.started,false) AND NOT COALESCE(operations.has_cutting,false)) AS cutting_missing
    FROM public.delivery_urgency_recoveries recovery
    JOIN public.ordres_fabrication source ON source.id=recovery.recovery_of_id
    JOIN public.ordres_fabrication producer ON producer.client_id=source.client_id
      AND producer.article_id=source.article_id AND producer.piece_technique_id=source.piece_technique_id
      AND producer.piece_technique_version_id=source.piece_technique_version_id
      AND producer.technical_snapshot_sha256=source.technical_snapshot_sha256
    JOIN public.production_consolidations grouping ON grouping.producer_of_id=producer.id AND grouping.state='ACTIVE'
    LEFT JOIN LATERAL (
      SELECT bool_or(op.status::text='DONE' OR op.ended_at IS NOT NULL) AS operation_finished,
        bool_or(op.started_at IS NOT NULL OR op.status::text='RUNNING') AS started,
        bool_or(frozen.is_cutting) AS has_cutting,
        bool_or(frozen.is_cutting AND (op.status::text='DONE' OR op.ended_at IS NOT NULL)) AS cutting_finished
      FROM public.of_operations op
      CROSS JOIN LATERAL (SELECT EXISTS(SELECT 1
        FROM jsonb_array_elements(COALESCE(producer.technical_snapshot->'operations','[]'::jsonb)) definition
        WHERE definition->>'phase'=op.phase::text AND definition->>'type_operation'='DECOUPE') AS is_cutting) frozen
      WHERE op.of_id=producer.id AND (op.revision_id IS NULL OR EXISTS(
        SELECT 1 FROM public.of_revisions revision WHERE revision.id=op.revision_id AND revision.statut='ACTIVE'))
    ) operations ON true
    WHERE recovery.id=$1::uuid AND producer.id<>source.id AND producer.id>$2
      AND producer.statut::text IN('BROUILLON','PLANIFIE','EN_COURS','EN_PAUSE')
      AND producer.numero ILIKE $3 ESCAPE '\\'
      AND EXISTS(SELECT 1 FROM public.production_consolidation_allocations part
        WHERE part.consolidation_id=grouping.id AND part.state='ACTIVE')
      AND NOT EXISTS(SELECT 1 FROM public.production_consolidation_allocations part
        JOIN public.ordres_fabrication existing ON existing.id=part.source_of_id
        WHERE part.consolidation_id=grouping.id AND part.state='ACTIVE'
          AND existing.client_id IS DISTINCT FROM source.client_id)
    ORDER BY producer.id LIMIT $4`, [recoveryId, query.cursor ?? 0, pattern, query.limit + 1])).rows;
  const items = rows.slice(0, query.limit).map(row => ({ ...row, blocker: row.cutting_finished
    ? 'Découpe terminée : gardez un OF séparé.' : row.cutting_missing
        ? 'Découpe non identifiée sur ce regroupement engagé.' : null }));
  return { items, next_cursor: rows.length > query.limit ? items.at(-1)!.producer_of_id : null, available: true, reason: null };
}

export async function listRecoveryGroupingCandidates(recoveryId: string, query: RecoveryConsolidationCandidatesQuery) {
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const result = await readRecoveryGroupingCandidatesTx(tx, recoveryId, query);
    await tx.query('COMMIT');
    return result;
  } catch (error) { await tx.query('ROLLBACK'); throw error; }
  finally { tx.release(); }
}
