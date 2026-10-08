import type { MarginBasis } from "../domain/margin-engine";

// The current estimate owns only the active revision. Real time remains on the
// revision on which it was spent; revision copies reset that time to zero.
const ACTIVE_OPERATION = `(
  op.revision_id IS NULL OR EXISTS (
    SELECT 1 FROM public.of_revisions revision
    WHERE revision.id = op.revision_id AND revision.of_id = op.of_id AND revision.statut = 'ACTIVE'
  )
) AND op.status::text <> 'CANCELLED'`;

export function ofMarginOperationSourcesSql(basis: Exclude<MarginBasis, "QUOTED">): string {
  const hours = basis === "STANDARD" ? "op.temps_total_planned"
    : basis === "ACTUAL" ? "op.temps_total_real"
      : `CASE WHEN ${ACTIVE_OPERATION} THEN GREATEST(op.temps_total_planned, op.temps_total_real) ELSE op.temps_total_real END`;
  const predicate = basis === "STANDARD" ? ACTIVE_OPERATION
    : `(${ACTIVE_OPERATION}) OR op.temps_total_real > 0`;
  const source = basis === "STANDARD" ? "OF_OPERATION_STANDARD"
    : basis === "UPDATED" ? "OF_OPERATION_ESTIMATE_AT_COMPLETION" : "PRODUCTION_POINTAGES_RECALC";
  return `
    SELECT concat('of-operation:', op.id::text) AS key,
           CASE WHEN op.designation ILIKE '%contrôle%' OR op.designation ILIKE '%controle%' THEN 'CONTROL' ELSE 'OPERATOR' END::text AS category,
           CASE WHEN op.hourly_rate_applied > 0 AND ${hours} >= 0
                THEN round(op.hourly_rate_applied * (${hours}), 6)::text ELSE NULL END AS amount_ht,
           '${source}'::text AS source_type,
           op.id::text AS source_ref, op.updated_at::text AS observed_at,
           'ESTIMATED'::text AS source_reliability,
           'EUR'::text AS currency
    FROM public.of_operations op
    WHERE op.of_id = $1::bigint AND (${predicate})
    ORDER BY op.phase, op.id
  `;
}

export const OF_MARGIN_MEASUREMENTS_SQL = `
  WITH active_operations AS (
    SELECT op.id, op.phase, op.temps_total_planned
    FROM public.of_operations op
    WHERE op.of_id = $1::bigint AND (${ACTIVE_OPERATION})
  ), final_operation AS (
    SELECT id FROM active_operations ORDER BY phase DESC, id DESC LIMIT 1
  ), final_declarations AS (
    SELECT declaration.* FROM public.production_quantity_declarations declaration
    JOIN final_operation operation ON operation.id = declaration.operation_id
    WHERE declaration.of_id = $1::bigint
  )
  SELECT
    (SELECT sum(temps_total_planned) FROM active_operations)::text AS planned_hours,
    (SELECT sum(op.temps_total_real) FROM public.of_operations op WHERE op.of_id = $1::bigint)::text AS actual_hours,
    (SELECT sum(qty_good) FROM final_declarations)::text AS good_quantity,
    (SELECT sum(qty_pending_control) FROM final_declarations)::text AS pending_control_quantity,
    (SELECT id::text FROM final_operation) AS good_operation_id,
    (SELECT count(*)::integer FROM final_declarations) AS good_declaration_count,
    (SELECT max(declared_at)::text FROM final_declarations) AS good_declaration_freshness,
    'FINAL_ACTIVE_OPERATION_DECLARED'::text AS good_quantity_scope,
    'DECLARED_OPERATION_EVENTS'::text AS rework_quantity_scope,
    (SELECT sum(qty_scrap) FROM public.production_quantity_declarations WHERE of_id = $1::bigint)::text AS scrap_quantity,
    (SELECT sum(qty_rework) FROM public.production_quantity_declarations WHERE of_id = $1::bigint)::text AS rework_quantity,
    (SELECT count(*)::integer FROM public.production_quantity_declarations WHERE of_id = $1::bigint) AS declaration_count,
    (SELECT max(declared_at)::text FROM public.production_quantity_declarations WHERE of_id = $1::bigint) AS declaration_freshness
`;

// Each partial issue has its own immutable line. The reservation's mutable
// latest-movement pointer cannot reconstruct that history. A compensated
// original and the compensating IN must contribute no consumption cost.
export const OF_MARGIN_MATERIAL_SOURCES_SQL = `
  SELECT concat('stock-consumption:', line.id::text) AS key,
         'MATERIAL'::text AS category,
         CASE WHEN line.unit_cost IS NULL THEN NULL
              ELSE round(consumption.qty * line.unit_cost, 6)::text END AS amount_ht,
         'STOCK_POSTED_CONSUMPTION_COST'::text AS source_type,
         movement.id::text AS source_ref, consumption.effective_at::text AS observed_at,
         'DECLARED'::text AS source_reliability, line.currency::text AS currency
  FROM public.of_material_consumptions consumption
  JOIN public.stock_movement_lines line ON line.id = consumption.stock_movement_line_id
    AND line.movement_id = consumption.stock_movement_id
    AND line.article_id = consumption.article_id AND line.lot_id = consumption.lot_id
  JOIN public.stock_movements movement ON movement.id = consumption.stock_movement_id
  WHERE consumption.of_id = $1::bigint AND consumption.status = 'POSTED'
    AND consumption.compensates_id IS NULL AND consumption.compensated_by_id IS NULL
    AND movement.status::text = 'POSTED' AND movement.movement_type::text IN ('OUT', 'SCRAP')
    AND movement.reason_code IS DISTINCT FROM 'PRELEVEMENT_CONSOMMABLE'
    AND NOT EXISTS (SELECT 1 FROM public.stock_movements reversal
      WHERE reversal.reversal_of_id = movement.id AND reversal.status::text = 'POSTED')
  UNION ALL
  SELECT concat('stock-consumption-proof-missing:', line.id::text) AS key,
         CASE WHEN movement.reason_code = 'PRELEVEMENT_CONSOMMABLE' THEN 'PURCHASE' ELSE 'MATERIAL' END::text AS category,
         NULL::text AS amount_ht, 'STOCK_CONSUMPTION_PROOF_MISSING'::text AS source_type,
         movement.id::text AS source_ref, movement.posted_at::text AS observed_at,
         'UNKNOWN'::text AS source_reliability, line.currency::text AS currency
  FROM public.stock_movement_lines line
  JOIN public.stock_movements movement ON movement.id = line.movement_id
  WHERE movement.source_document_type = 'OF' AND movement.source_document_id = $1::bigint::text
    AND movement.status::text = 'POSTED' AND movement.movement_type::text IN ('OUT', 'SCRAP')
    AND movement.reason_code IS DISTINCT FROM 'PRELEVEMENT_CONSOMMABLE'
    AND NOT EXISTS (SELECT 1 FROM public.of_material_consumptions consumption WHERE consumption.stock_movement_line_id = line.id)
    AND NOT EXISTS (SELECT 1 FROM public.stock_movements reversal
      WHERE reversal.reversal_of_id = movement.id AND reversal.status::text = 'POSTED')
  ORDER BY key
`;
