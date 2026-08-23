import pool from "../../config/database";

/**
 * Read model for the subcontract board.  It is deliberately scoped by the
 * canonical OF id: callers must never be able to enumerate every supplier
 * work package merely by omitting a filter.
 */
export async function repoListSubcontractWorkPackagesForOf(ofId: number) {
  const result = await pool.query(`
    SELECT
      o.of_id,
      p.id, p.supplier_order_line_id, p.of_operation_id, p.status, p.unit,
      p.qty_planned, p.row_version, p.ged_evidence_document_id, p.created_at,
      p.closed_at, p.close_reason,
      COALESCE(sum(e.qty) FILTER (WHERE e.event_type = 'ISSUE'), 0) AS issued_qty,
      COALESCE(sum(e.qty) FILTER (WHERE e.event_type = 'RETURN'), 0) AS returned_qty,
      COALESCE(sum(e.qty) FILTER (WHERE e.event_type = 'ISSUE'), 0)
        - COALESCE(sum(e.qty) FILTER (WHERE e.event_type = 'RETURN'), 0) AS custody_open_qty,
      count(e.id)::int AS ledger_event_count,
      max(e.created_at) AS last_ledger_at,
      COALESCE(json_agg(json_build_object(
        'id', e.id, 'event_type', e.event_type, 'lot_id', e.lot_id,
        'qty', e.qty, 'unit', e.unit, 'created_at', e.created_at
      ) ORDER BY e.created_at) FILTER (WHERE e.id IS NOT NULL), '[]'::json) AS ledger
    FROM public.subcontract_work_packages p
    JOIN public.of_operations o ON o.id = p.of_operation_id
    LEFT JOIN public.subcontract_work_package_ledger e ON e.package_id = p.id
    WHERE o.of_id = $1
    GROUP BY o.of_id, p.id
    ORDER BY p.created_at DESC, p.id DESC
  `, [ofId]);
  return result.rows;
}
