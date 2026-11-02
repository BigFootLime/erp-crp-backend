import type { PoolClient } from "pg";
import type { RoutingStep } from "../domain/industrial-capacity";
type Db = Pick<PoolClient, "query">;
export type TreatmentAssumption = {
  line_id: string;
  order_code: string;
  estimated_return_date: string;
  need_date: string | null;
  confirmed_date: string | null;
  remaining_quantity: number;
};

/** Internal what-if dates. These rows never enter the stock or CBN supply arrays. */
export async function readIndustrialRouting(db: Db, articles: string[]) {
  return (
    await db.query<RoutingStep>(
      `SELECT a.id::text AS article_id,op.id::text AS operation_id,op.phase,op.designation AS label,op.type_operation::text AS kind,
  op.tp::float8*60 AS setup_minutes,(op.tf_unit*COALESCE(op.qte,1)*COALESCE(op.coef,1))::float8*60 AS unit_minutes,
  CASE WHEN op.machine_id IS NOT NULL THEN ARRAY['machine:'||op.machine_id::text] ELSE '{}'::text[] END ||
  CASE WHEN op.poste_id IS NOT NULL THEN ARRAY['poste:'||op.poste_id::text] ELSE '{}'::text[] END ||
  COALESCE((SELECT array_agg('machine:'||m.id::text ORDER BY m.id) FROM public.machines m
    WHERE m.id IS DISTINCT FROM op.machine_id AND m.archived_at IS NULL AND m.status='ACTIVE' AND m.is_available IS NOT FALSE
     AND NULLIF(trim(op.machine_family_code),'') IS NOT NULL AND upper(trim(m.machine_family_code))=upper(trim(op.machine_family_code))
     AND NOT EXISTS(SELECT 1 FROM public.production_maintenance_holds h WHERE h.machine_id=m.id AND h.resolved_at IS NULL)),'{}'::text[]) AS resource_ids
  FROM public.articles a JOIN LATERAL(SELECT v.id FROM public.piece_technique_versions v WHERE v.piece_technique_id=a.piece_technique_id AND v.statut='APPLICABLE'
   AND(v.date_application IS NULL OR v.date_application<=CURRENT_DATE) ORDER BY v.date_application DESC NULLS LAST,v.version_interne DESC,v.created_at DESC,v.id LIMIT 1) v ON true
  JOIN public.gammes g ON g.piece_technique_version_id=v.id AND g.is_current JOIN public.pieces_techniques_operations op ON op.gamme_id=g.id
  WHERE a.id=ANY($1::uuid[]) ORDER BY a.id,op.phase,op.id`,
      [articles],
    )
  ).rows;
}
export async function readIndustrialAbc(
  db: Db,
  articleIds: string[],
  today: string,
) {
  // Exclude transfers and reversals of reversed movements. Missing EUR costs never rank as zero.
  return (
    await db.query(
      `WITH usage AS (
 SELECT a.id::text AS article_id,a.code,a.unite AS unit,
 COALESCE(sum(abs(l.qty)) FILTER(WHERE m.id IS NOT NULL),0) AS quantity,
 CASE WHEN count(*) FILTER(WHERE m.id IS NOT NULL AND(l.unit_cost IS NULL OR COALESCE(l.currency,m.currency,'')<>'EUR' OR upper(l.unite) IS DISTINCT FROM upper(a.unite)))>0 THEN NULL
 ELSE COALESCE(sum(abs(l.qty)*l.unit_cost) FILTER(WHERE m.id IS NOT NULL),0) END AS value
 FROM public.articles a LEFT JOIN public.stock_movement_lines l ON l.article_id=a.id
 LEFT JOIN public.stock_movements m ON m.id=l.movement_id AND m.status='POSTED' AND m.movement_type='OUT'
 AND m.effective_at>=$2::date-interval '12 months' AND m.effective_at<$2::date+interval '1 day'
 AND m.reversal_of_id IS NULL AND NOT EXISTS(SELECT 1 FROM public.stock_movements reversal WHERE reversal.reversal_of_id=m.id AND reversal.status='POSTED')
 WHERE a.id=ANY($1::uuid[]) GROUP BY a.id,a.code,a.unite
 ),ranked AS(SELECT *,COALESCE(sum(value) OVER(ORDER BY value DESC NULLS LAST,article_id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0) AS prior,
 sum(value) OVER() AS total FROM usage)
 SELECT article_id,code,unit,quantity::float8,value::float8 AS consumption_eur,
 CASE WHEN value IS NULL OR total=0 THEN NULL WHEN value=0 THEN 'C' WHEN prior/total<0.80 THEN 'A' WHEN prior/total<0.95 THEN 'B' ELSE 'C' END AS class
 FROM ranked ORDER BY value DESC NULLS LAST,article_id`,
      [articleIds, today],
    )
  ).rows;
}
