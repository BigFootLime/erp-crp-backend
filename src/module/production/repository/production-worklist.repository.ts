import pool from "../../../config/database";
import type { WorklistQuery } from "../validators/production-workbench.validators";
import { effectivePreparationVersionSql } from "./effective-preparation-version.sql";
import { committedOperationSql } from "../../planning/repository/committed-operation.sql";
import { CLIENT_CODE_ORDER_SQL } from "../../client/repository/client-code.sql";

/** One SQL statement gives counters, page and clock the same MVCC snapshot. */
export async function repoProductionWorklist(input: WorklistQuery) {
  const result = await pool.query<{ payload: Record<string, unknown> }>(
    `
    WITH clock AS (
      SELECT statement_timestamp() AS now,
        EXISTS(SELECT 1 FROM public.app_feature_flags WHERE key='PRODUCTION_MATERIAL_WORKFLOW' AND enabled) AS material_enabled
    ), order_deadlines AS MATERIALIZED (
      SELECT cc.id,cc.created_at,public.workshop_working_deadline(cc.created_at,48) AS deadline FROM public.commande_client cc
      WHERE EXISTS(SELECT 1 FROM public.ordres_fabrication active WHERE active.commande_id=cc.id AND active.statut NOT IN('ANNULE','TERMINE','CLOTURE'))
    ), base AS (
      SELECT o.id::bigint::int AS id,o.numero,o.priority::text,o.statut::text,
         CASE WHEN o.statut='BROUILLON' AND o.technical_readiness='VALIDATED' AND o.preparation_rules_version>=2
           AND NOT EXISTS (SELECT 1 FROM public.of_dossier_validations v WHERE v.of_id=o.id AND v.invalidated_at IS NULL)
           THEN 'INCOMPLETE' ELSE o.technical_readiness END AS technical_readiness,
         o.piece_technique_id::text,o.piece_technique_version_id::text,o.article_id::text,o.technical_snapshot_sha256,
         pt.code_piece AS piece_code,pt.designation AS piece_designation,
        o.client_id,c.company_name AS client_company_name,
        o.parent_of_id::bigint::int,parent.numero AS parent_numero,o.root_of_id::bigint::int,
         o.generation_level,o.structure_path,o.quantite_lancee::float8,o.quantite_bonne::float8,o.quantite_rebut::float8,
         (SELECT count(*)::int FROM public.planning_events e WHERE (e.of_id=o.id OR e.of_operation_id IN(SELECT id FROM public.of_operations WHERE of_id=o.id))
           AND e.archived_at IS NULL AND e.status<>'CANCELLED') AS consolidation_planned_count,
         (SELECT count(*)::int FROM public.of_operations p WHERE p.of_id=o.id AND p.status::text NOT IN ('TODO','READY')) AS consolidation_started_count,
         EXISTS(SELECT 1 FROM public.production_consolidations g WHERE g.producer_of_id=o.id) AS was_consolidation_producer,
        o.date_fin_prevue::text,o.updated_at::text,o.created_at::text,
        o.planning_wait_started_at::text,
        COALESCE(v.manufacturing_mode,'SIMPLE') AS manufacturing_mode,v.indice,
        COALESCE(op.total,0)::int AS total_operations,COALESCE(op.planned,0)::int AS planned_operations,
        CASE WHEN op.total>0 AND op.planned>=op.total THEN 'COMPLETE' WHEN op.planned>0 THEN 'PARTIAL' ELSE 'NONE' END AS planning_state,
        coverage.consolidation_id::text AS covered_by_group_id,producer.producer_of_id::bigint::int AS covered_by_of_id,
        own_group.id::text AS consolidation_id,
        CASE
          WHEN NOT clock.material_enabled OR o.technical_snapshot_sha256 IS NULL THEN 'NONE'
          WHEN material.configured < material_definitions.total THEN 'TO_SUPPLY'
          WHEN material.uncovered > 0 THEN 'TO_SUPPLY'
          WHEN material.waiting > 0 THEN 'WAITING'
          WHEN material.configured > 0 THEN 'AVAILABLE'
          ELSE 'NONE'
        END AS material_state,
        (o.statut IN ('BROUILLON','PLANIFIE') AND coverage.id IS NULL
          AND NOT(COALESCE(op.total,0)>0 AND COALESCE(op.planned,0)>=op.total)
           AND COALESCE(deadline.deadline <= clock.now,false)) AS overdue,
         deadline.deadline::text AS priority_deadline,deadline.created_at::text AS priority_started_at,
         deadline.deadline IS NULL AS priority_calendar_missing
      FROM public.ordres_fabrication o
      JOIN public.pieces_techniques pt ON pt.id=o.piece_technique_id
      LEFT JOIN public.clients c ON c.client_id=o.client_id
      LEFT JOIN public.ordres_fabrication parent ON parent.id=o.parent_of_id
      LEFT JOIN public.piece_technique_versions v ON v.id=${effectivePreparationVersionSql("o")}
      LEFT JOIN public.production_consolidation_allocations coverage ON coverage.source_of_id=o.id AND coverage.state='ACTIVE'
      LEFT JOIN public.production_consolidations producer ON producer.id=coverage.consolidation_id
      LEFT JOIN public.production_consolidations own_group ON own_group.producer_of_id=o.id AND own_group.state='ACTIVE'
      LEFT JOIN LATERAL (SELECT min(d.created_at) AS created_at,min(d.deadline) AS deadline FROM order_deadlines d
        WHERE d.id=o.commande_id OR EXISTS(SELECT 1 FROM public.production_consolidation_allocations a
          JOIN public.ordres_fabrication source ON source.id=a.source_of_id WHERE a.consolidation_id=own_group.id
          AND a.state='ACTIVE' AND source.commande_id=d.id)) deadline ON true
      LEFT JOIN LATERAL (
        SELECT count(*) AS total, count(*) FILTER(WHERE ${committedOperationSql("p", "o")}) AS planned
        FROM public.of_operations p WHERE p.of_id=o.id AND p.status::text<>'CANCELLED' AND (
          p.revision_id IS NULL OR p.revision_id IN(SELECT r.id FROM public.of_revisions r WHERE r.of_id=o.id AND r.statut='ACTIVE'))
      ) op ON true CROSS JOIN clock
      LEFT JOIN LATERAL (
        SELECT count(*) AS total
        FROM jsonb_array_elements(COALESCE(o.technical_snapshot->'preparation_evidence'->'purchases',(
          SELECT jsonb_agg(to_jsonb(purchase)) FROM public.pieces_techniques_achats purchase
          WHERE purchase.piece_technique_id=o.piece_technique_id
            AND purchase.piece_technique_version_id=o.piece_technique_version_id
        ),'[]'::jsonb)) p
        WHERE p->>'type_achat'='MATIERE'
      ) material_definitions ON clock.material_enabled AND o.technical_snapshot_sha256 IS NOT NULL
      LEFT JOIN LATERAL (
        SELECT count(*) AS configured,
          count(*) FILTER(WHERE coverage.qty + incoming.qty < n.required_qty) AS uncovered,
          count(*) FILTER(WHERE coverage.qty < n.required_qty AND coverage.qty + incoming.qty >= n.required_qty) AS waiting
        FROM public.of_material_needs n
        CROSS JOIN LATERAL (
          SELECT COALESCE(sum(CASE WHEN r.status='CONSUMED' THEN r.qty_reserved
            WHEN r.status='ACTIVE' AND (r.expires_at IS NULL OR r.expires_at>clock.now)
              AND l.lot_status='LIBERE' THEN r.qty_reserved ELSE r.qty_consumed END),0) AS qty
          FROM public.stock_reservations r
          LEFT JOIN public.lots l ON l.id=r.lot_id
          WHERE r.material_need_id=n.id
        ) coverage
        CROSS JOIN LATERAL (
          SELECT COALESCE((
            SELECT sum(GREATEST(0,(CASE WHEN b.besoin_type='OF_MATERIAL' THEN b.quantite_couverte
              ELSE b.quantite_couverte*COALESCE(l.coef_conversion,1) END)-COALESCE(transfers.qty,0)))
            FROM public.commande_fournisseur_ligne_besoin b
            JOIN public.commande_fournisseur_ligne l ON l.id=b.ligne_id AND l.statut_ligne='ACTIVE'
            JOIN public.commande_fournisseur c ON c.id=l.commande_id AND c.statut NOT IN ('ANNULEE','CLOTUREE')
            LEFT JOIN LATERAL (SELECT sum(r.qty_reserved) AS qty FROM public.of_material_receipt_transfers t
              JOIN public.stock_reservations r ON r.id=t.reservation_id WHERE t.purchase_need_id=b.id) transfers ON true
            WHERE b.material_need_id=n.id AND NOT b.annule
          ),0) + COALESCE((
            SELECT sum(GREATEST(0,c.quantity-COALESCE(transfers.qty,0))) FROM public.of_customer_material_calls c
            LEFT JOIN LATERAL (SELECT sum(r.qty_reserved) AS qty FROM public.of_customer_material_receipt_transfers t
              JOIN public.stock_reservations r ON r.id=t.reservation_id WHERE t.call_id=c.id) transfers ON true
            WHERE c.need_id=n.id AND c.status IN ('SENT','ANNOUNCED')
          ),0) AS qty
        ) incoming
        WHERE n.of_id=o.id AND n.need_kind='MATIERE' AND n.superseded_at IS NULL AND n.technical_hash=o.technical_snapshot_sha256
      ) material ON clock.material_enabled AND o.technical_snapshot_sha256 IS NOT NULL
      WHERE ($1='' OR concat_ws(' ',o.numero,pt.code_piece,pt.designation,c.company_name,parent.numero) ILIKE '%'||$1||'%')
        AND ($2::text IS NULL OR o.client_id=$2)
        AND ($7::uuid IS NULL OR o.piece_technique_id=$7::uuid)
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
    ), filtered AS (SELECT * FROM classified WHERE $4='ALL' OR ($4='OVERDUE' AND overdue) OR queue=$4
      OR ($4='MATERIAL_TO_SUPPLY' AND technical_readiness='VALIDATED' AND queue NOT IN ('COVERED','RUNNING') AND material_state='TO_SUPPLY')
      OR ($4='MATERIAL_WAITING' AND technical_readiness='VALIDATED' AND queue NOT IN ('COVERED','RUNNING') AND material_state='WAITING')
      OR ($4='RUNNING' AND queue='PLANNED' AND material_state='AVAILABLE')),
    page AS (SELECT * FROM filtered ORDER BY overdue DESC,CASE priority WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'NORMAL' THEN 2 ELSE 3 END,planning_wait_started_at ASC NULLS LAST,date_fin_prevue ASC NULLS LAST,id LIMIT $5 OFFSET $6)
    SELECT jsonb_build_object('items',COALESCE((SELECT jsonb_agg(to_jsonb(p)) FROM page p),'[]'::jsonb),
      'total',(SELECT count(*) FROM filtered),'server_time',clock.now,
      'clients',(SELECT COALESCE(jsonb_agg(jsonb_build_object('value',c.client_id,'label',c.company_name)
        ORDER BY ${CLIENT_CODE_ORDER_SQL}),'[]'::jsonb)
        FROM public.clients c WHERE EXISTS (SELECT 1 FROM public.ordres_fabrication o
          WHERE o.client_id=c.client_id AND o.statut NOT IN ('ANNULE','TERMINE','CLOTURE'))),
      'next_deadline',(SELECT min(priority_deadline::timestamptz) FROM classified WHERE priority_deadline::timestamptz>clock.now AND planning_state<>'COMPLETE' AND queue<>'COVERED'),
      'counts',jsonb_build_object('ALL',(SELECT count(*) FROM classified),'OVERDUE',(SELECT count(*) FROM classified WHERE overdue),
        'PREPARATION',(SELECT count(*) FROM classified WHERE queue='PREPARATION'),
        'REVIEW',(SELECT count(*) FROM classified WHERE queue='REVIEW'),
        'READY',(SELECT count(*) FROM classified WHERE queue='READY'),
        'MATERIAL_TO_SUPPLY',(SELECT count(*) FROM classified WHERE technical_readiness='VALIDATED' AND queue NOT IN ('COVERED','RUNNING') AND material_state='TO_SUPPLY'),
        'MATERIAL_WAITING',(SELECT count(*) FROM classified WHERE technical_readiness='VALIDATED' AND queue NOT IN ('COVERED','RUNNING') AND material_state='WAITING'),
        'PLANNED',(SELECT count(*) FROM classified WHERE queue='PLANNED'),
        'RUNNING',(SELECT count(*) FROM classified WHERE queue='RUNNING' OR (queue='PLANNED' AND material_state='AVAILABLE')),
        'COVERED',(SELECT count(*) FROM classified WHERE queue='COVERED'))) AS payload FROM clock
  `,
    [
      input.q,
      input.client_id ?? null,
      input.kind,
      input.queue,
      input.pageSize,
      (input.page - 1) * input.pageSize,
      input.piece_technique_id ?? null,
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
    OR EXISTS(SELECT 1 FROM public.ordres_fabrication WHERE preparation_rules_version>=1 AND statut::text NOT IN ('ANNULE','CLOTURE','TERMINE'))) AS enabled,
    EXISTS(SELECT 1 FROM public.app_feature_flags WHERE key='PRODUCTION_CONSOLIDATION' AND enabled) AS consolidation_enabled`)
  ).rows[0];
  return row;
}
