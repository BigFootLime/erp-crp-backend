import pool from '../../../config/database';
import { HttpError } from '../../../utils/httpError';
import type { MasterPlanOrderSource, MasterPlanPeriod } from '../types/planning-master-plan.types';
import type { MasterPlanQuery } from '../validators/planning-master-plan.validators';
import { readCentralSnapshot } from './planning-central.repository';

/** PostgreSQL civil boundaries preserve the October/March clock change. */
export const MASTER_PLAN_PERIODS_SQL = `
SELECT to_char(day,'YYYY-MM-DD') AS label,
  (day::timestamp AT TIME ZONE 'Europe/Paris')::text AS start,
  ((day+7)::timestamp AT TIME ZONE 'Europe/Paris')::text AS "end"
FROM (SELECT date_trunc('week',$1::date)::date+n*7 AS day
      FROM generate_series(0,$2::int-1) n) periods ORDER BY day`;

export const MASTER_PLAN_ORDERS_SQL = `
SELECT o.id::int, o.numero AS number, o.piece_technique_id::text AS "pieceId", pt.code_piece AS reference,
 v.indice, v.version_interne::int AS version, o.quantite_lancee::float8 AS quantity,
 o.quantite_bonne::float8 AS good, o.statut::text AS status,
 (SELECT count(*)::int FROM public.of_operations op WHERE op.of_id=o.id AND op.status::text<>'CANCELLED'
   AND (op.revision_id IS NULL OR EXISTS(SELECT 1 FROM public.of_revisions r WHERE r.id=op.revision_id AND r.statut='ACTIVE'))) AS "operationCount",
 COALESCE((SELECT array_agg(DISTINCT issue.value ORDER BY issue.value) FROM public.planning_tasks t
   JOIN public.of_operations op ON op.id=t.operation_id
   CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(t.forecast_issues,'[]'::jsonb)) issue(value)
   WHERE op.of_id=o.id AND op.status::text<>'CANCELLED' AND
    (op.revision_id IS NULL OR EXISTS(SELECT 1 FROM public.of_revisions r WHERE r.id=op.revision_id AND r.statut='ACTIVE'))),'{}'::text[]) AS "forecastIssues",
 COALESCE(due.value::date,o.date_fin_prevue::date)::text AS due,
 COALESCE((SELECT array_agg(t.id ORDER BY t.id) FROM public.planning_tasks t
   LEFT JOIN public.of_operations op ON op.id=t.operation_id
   WHERE (op.of_id=o.id AND op.status::text<>'CANCELLED' AND
     (op.revision_id IS NULL OR EXISTS(SELECT 1 FROM public.of_revisions r WHERE r.id=op.revision_id AND r.statut='ACTIVE')))
     OR t.draft_of_id=o.id),'{}'::text[]) AS "taskIds"
FROM public.ordres_fabrication o JOIN public.pieces_techniques pt ON pt.id=o.piece_technique_id
LEFT JOIN public.piece_technique_versions v ON v.id=o.piece_technique_version_id
LEFT JOIN LATERAL (
 SELECT min(COALESCE(promise.due,CASE WHEN cc.order_type='INTERNE' THEN COALESCE(cl.delai_interne,cl.delai_client) ELSE cl.delai_client END)) AS value
 FROM (SELECT o.commande_ligne_id AS line_id
   UNION SELECT source.commande_ligne_id FROM public.production_consolidations c
     JOIN public.production_consolidation_allocations a ON a.consolidation_id=c.id AND a.state='ACTIVE'
     JOIN public.ordres_fabrication source ON source.id=a.source_of_id WHERE c.producer_of_id=o.id) owners
 LEFT JOIN public.commande_ligne cl ON cl.id=owners.line_id
 LEFT JOIN public.commande_client cc ON cc.id=cl.commande_id
 LEFT JOIN LATERAL (SELECT min(p.due_date) AS due FROM public.delivery_promise_roots r
    JOIN public.delivery_promise_parts p ON p.root_id=r.id AND p.retired_at IS NULL
    WHERE r.line_id=cl.id AND p.quantity>COALESCE((SELECT sum(s.quantity)
      FROM public.delivery_promise_shipments s WHERE s.part_id=p.id),0)) promise ON true
) due ON true
WHERE o.statut::text NOT IN ('ANNULE','TERMINE')
 AND NOT EXISTS(SELECT 1 FROM public.production_consolidation_allocations a WHERE a.source_of_id=o.id AND a.state='ACTIVE')
ORDER BY COALESCE(due.value,o.date_fin_prevue) NULLS LAST,o.id LIMIT 2001`;

export async function readMasterPlanSource(query: MasterPlanQuery) {
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const periods = (await tx.query<MasterPlanPeriod>(MASTER_PLAN_PERIODS_SQL, [query.start, query.weeks])).rows
      .map(period => ({ ...period, start: new Date(period.start).toISOString(), end: new Date(period.end).toISOString() }));
    const orders = (await tx.query<MasterPlanOrderSource>(MASTER_PLAN_ORDERS_SQL)).rows;
    if (orders.length > 2000) throw new HttpError(422, 'MASTER_PLAN_SCOPE_TOO_LARGE', 'La synthèse dépasse 2 000 OF actifs.');
    const snapshot = await readCentralSnapshot({ from: periods[0].start, to: periods.at(-1)!.end, limit: 10000,
      includeTaskIds: orders.flatMap(order => order.taskIds), include_coverage: false, snapshot_revision: query.revision }, tx, false);
    if (snapshot.nextCursor) throw new HttpError(422, 'MASTER_PLAN_SCOPE_TOO_LARGE', 'La synthèse dépasse 10 000 opérations. Aucune synthèse partielle n’a été produite.');
    await tx.query('COMMIT');
    return { periods, orders, snapshot };
  } catch (error) { await tx.query('ROLLBACK'); throw error; }
  finally { tx.release(); }
}
