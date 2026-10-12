import type { PoolClient } from 'pg';

/** $1 is the selected OF array. Follow physical producers back to their
 * commercial sources and source roots, including a producer's child OFs.
 * UNION terminates even if legacy genealogy contains a cycle. Dissolved
 * groups and inactive allocations confer no current execution authority. */
export const RECOVERY_PRODUCTION_SCOPE_SQL = `WITH RECURSIVE production_edges AS (
  SELECT id AS of_id, COALESCE(root_of_id,id) AS source_of_id FROM public.ordres_fabrication
  UNION ALL
  SELECT grouping.producer_of_id, allocation.source_of_id
  FROM public.production_consolidations grouping
  JOIN public.production_consolidation_allocations allocation ON allocation.consolidation_id=grouping.id
  WHERE grouping.state='ACTIVE' AND allocation.state='ACTIVE'
), production_scope(selected_of_id,source_of_id) AS (
  SELECT id,id FROM public.ordres_fabrication WHERE id=ANY($1::bigint[])
  UNION
  SELECT scope.selected_of_id,edge.source_of_id
  FROM production_scope scope JOIN production_edges edge ON edge.of_id=scope.source_of_id
)`;

export type UrgencyRecoveryScope = {
  selected_of_id: number;
  recovery_of_id: number;
  request_id: string;
  status: string;
  cancellation_retains_production: boolean | null;
  client_id: string;
};

export async function readUrgencyRecoveryScopesTx(
  tx: Pick<PoolClient, 'query'>,
  ofIds: readonly number[],
  statuses: readonly string[],
): Promise<UrgencyRecoveryScope[]> {
  if (!ofIds.length) return [];
  return (await tx.query<UrgencyRecoveryScope>(`${RECOVERY_PRODUCTION_SCOPE_SQL}
    SELECT scope.selected_of_id::int,recovery.recovery_of_id::int,request.id::text AS request_id,
      request.status,request.cancellation_retains_production,source.client_id::text
    FROM production_scope scope
    JOIN public.delivery_urgency_recoveries recovery ON recovery.recovery_of_id=scope.source_of_id
    JOIN public.delivery_urgency_requests request ON request.id=recovery.request_id
    JOIN public.ordres_fabrication source ON source.id=recovery.recovery_of_id
    WHERE request.status=ANY($2::text[])
    ORDER BY scope.selected_of_id,request.id,recovery.id`, [[...new Set(ofIds)], statuses])).rows;
}

export async function readOtherClientProductionScopesTx(
  tx: Pick<PoolClient, 'query'>, ofIds: readonly number[], clientId: string,
): Promise<number[]> {
  if (!ofIds.length) return [];
  return (await tx.query<{ of_id: number }>(`${RECOVERY_PRODUCTION_SCOPE_SQL}
    SELECT DISTINCT scope.selected_of_id::int AS of_id
    FROM production_scope scope JOIN public.ordres_fabrication source ON source.id=scope.source_of_id
    WHERE source.client_id IS DISTINCT FROM $2 ORDER BY of_id`, [[...new Set(ofIds)], clientId])).rows.map(row => row.of_id);
}
