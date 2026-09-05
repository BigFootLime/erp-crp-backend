import pool from "../../../config/database";
import type { WorklistQuery } from "../validators/production-workbench.validators";

/** One SQL statement gives counters, page and clock the same MVCC snapshot. */
export async function repoProductionWorklist(input: WorklistQuery) {
  const result = await pool.query<{ payload: Record<string, unknown> }>(
    `
    WITH clock AS (SELECT statement_timestamp() AS now), base AS (
      SELECT o.id::bigint::int AS id,o.numero,o.priority::text,o.statut::text,o.technical_readiness,
        o.piece_technique_id::text,pt.code_piece AS piece_code,pt.designation AS piece_designation,
        o.client_id,c.company_name AS client_company_name,
        o.parent_of_id::bigint::int,parent.numero AS parent_numero,o.root_of_id::bigint::int,
        o.generation_level,o.structure_path,o.quantite_lancee::float8,o.quantite_bonne::float8,
        o.date_fin_prevue::text,o.updated_at::text,o.created_at::text,
        o.planning_wait_started_at::text,
        COALESCE(v.manufacturing_mode,'SIMPLE') AS manufacturing_mode,v.indice,
        COALESCE(op.total,0)::int AS total_operations,COALESCE(op.planned,0)::int AS planned_operations,
        CASE WHEN op.total>0 AND op.planned>=op.total THEN 'COMPLETE' WHEN op.planned>0 THEN 'PARTIAL' ELSE 'NONE' END AS planning_state,
        coverage.consolidation_id::text AS covered_by_group_id,producer.producer_of_id::bigint::int AS covered_by_of_id,
        own_group.id::text AS consolidation_id,
        (o.statut IN ('BROUILLON','PLANIFIE') AND coverage.id IS NULL
          AND NOT(COALESCE(op.total,0)>0 AND COALESCE(op.planned,0)>=op.total)
          AND o.planning_wait_started_at + interval '48 hours' <= clock.now) AS overdue,
        (o.planning_wait_started_at+interval '48 hours')::text AS priority_deadline
      FROM public.ordres_fabrication o
      JOIN public.pieces_techniques pt ON pt.id=o.piece_technique_id
      LEFT JOIN public.clients c ON c.client_id=o.client_id
      LEFT JOIN public.ordres_fabrication parent ON parent.id=o.parent_of_id
      LEFT JOIN public.piece_technique_versions v ON v.id=COALESCE(o.piece_technique_version_id,
        NULLIF(o.technical_preparation->>'selected_version_id','')::uuid,
        NULLIF(o.technical_preparation->>'selected_draft_version_id','')::uuid)
      LEFT JOIN public.production_consolidation_allocations coverage ON coverage.source_of_id=o.id AND coverage.state='ACTIVE'
      LEFT JOIN public.production_consolidations producer ON producer.id=coverage.consolidation_id
      LEFT JOIN public.production_consolidations own_group ON own_group.producer_of_id=o.id AND own_group.state='ACTIVE'
      LEFT JOIN LATERAL (
        SELECT count(*) AS total, count(*) FILTER(WHERE EXISTS (
          SELECT 1 FROM public.planning_events e WHERE e.of_operation_id=p.id
          AND e.archived_at IS NULL AND e.status<>'CANCELLED' AND e.end_ts>e.start_ts
          AND (e.machine_id IS NOT NULL OR e.poste_id IS NOT NULL)
        )) AS planned FROM public.of_operations p WHERE p.of_id=o.id AND (
          p.revision_id IS NULL OR p.revision_id IN(SELECT r.id FROM public.of_revisions r WHERE r.of_id=o.id AND r.statut='ACTIVE'))
      ) op ON true CROSS JOIN clock
      WHERE ($1='' OR concat_ws(' ',o.numero,pt.code_piece,pt.designation,c.company_name,parent.numero) ILIKE '%'||$1||'%')
        AND ($2::text IS NULL OR o.client_id=$2)
        AND ($3='ALL' OR ($3='ROOT' AND o.parent_of_id IS NULL) OR ($3='CHILD' AND o.parent_of_id IS NOT NULL)
          OR ($3='ASSEMBLY' AND v.manufacturing_mode='ASSEMBLY') OR ($3='CONSOLIDATION' AND own_group.id IS NOT NULL))
        AND o.statut NOT IN ('ANNULE','TERMINE','CLOTURE')
    ), classified AS (
      SELECT *,CASE WHEN covered_by_group_id IS NOT NULL THEN 'COVERED'
        WHEN statut NOT IN ('BROUILLON','PLANIFIE') THEN 'RUNNING'
        WHEN planning_state='COMPLETE' THEN 'PLANNED'
        WHEN technical_readiness='VALIDATED' THEN 'READY'
        WHEN technical_readiness='READY_FOR_REVIEW' THEN 'REVIEW' ELSE 'PREPARATION' END AS queue
      FROM base
    ), filtered AS (SELECT * FROM classified WHERE $4='ALL' OR ($4='OVERDUE' AND overdue) OR queue=$4),
    page AS (SELECT * FROM filtered ORDER BY overdue DESC,CASE priority WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'NORMAL' THEN 2 ELSE 3 END,planning_wait_started_at ASC NULLS LAST,date_fin_prevue ASC NULLS LAST,id LIMIT $5 OFFSET $6)
    SELECT jsonb_build_object('items',COALESCE((SELECT jsonb_agg(to_jsonb(p)) FROM page p),'[]'::jsonb),
      'total',(SELECT count(*) FROM filtered),'server_time',clock.now,
      'clients',(SELECT COALESCE(jsonb_agg(to_jsonb(c) ORDER BY c.label),'[]'::jsonb) FROM (SELECT DISTINCT c.client_id AS value,c.company_name AS label FROM public.clients c JOIN public.ordres_fabrication o ON o.client_id=c.client_id WHERE o.statut NOT IN ('ANNULE','TERMINE','CLOTURE')) c),
      'next_deadline',(SELECT min(priority_deadline::timestamptz) FROM classified WHERE priority_deadline::timestamptz>clock.now AND planning_state<>'COMPLETE' AND queue<>'COVERED'),
      'counts',jsonb_build_object('ALL',(SELECT count(*) FROM classified),'OVERDUE',(SELECT count(*) FROM classified WHERE overdue),
        'PREPARATION',(SELECT count(*) FROM classified WHERE queue='PREPARATION'),
        'REVIEW',(SELECT count(*) FROM classified WHERE queue='REVIEW'),
        'READY',(SELECT count(*) FROM classified WHERE queue='READY'),
        'PLANNED',(SELECT count(*) FROM classified WHERE queue='PLANNED'),
        'RUNNING',(SELECT count(*) FROM classified WHERE queue='RUNNING'),
        'COVERED',(SELECT count(*) FROM classified WHERE queue='COVERED'))) AS payload FROM clock
  `,
    [
      input.q,
      input.client_id ?? null,
      input.kind,
      input.queue,
      input.pageSize,
      (input.page - 1) * input.pageSize,
    ],
  );
  return result.rows[0].payload;
}

export async function repoProductionWorkbenchConfig() {
  const row = (
    await pool.query<{
      enabled: boolean;
      consolidation_enabled: boolean;
    }>(`SELECT
    (EXISTS(SELECT 1 FROM public.app_feature_flags WHERE key='PRODUCTION_WORKBENCH' AND enabled)
    OR EXISTS(SELECT 1 FROM public.ordres_fabrication WHERE preparation_rules_version=1 AND statut::text NOT IN ('ANNULE','CLOTURE','TERMINE'))) AS enabled,
    EXISTS(SELECT 1 FROM public.app_feature_flags WHERE key='PRODUCTION_CONSOLIDATION' AND enabled) AS consolidation_enabled`)
  ).rows[0];
  return row;
}
