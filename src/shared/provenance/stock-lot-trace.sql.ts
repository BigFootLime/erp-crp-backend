type TraceKind = 'MP_LOT' | 'TRAITEMENT_LOT';

/** Read recorded origins. Do not turn an arbitrary outsourced operation into a treatment. */
export function stockLotTraceReferenceValuesSql(lotExpression: string, kind: TraceKind): string {
  if (!/^[a-z][a-z0-9_]*\.(?:id|lot_id)$/.test(lotExpression)
    || !['MP_LOT', 'TRAITEMENT_LOT'].includes(kind)) throw new Error('Invalid static lot trace expression');
  const recorded = `SELECT trace_reference.reference_value
    FROM public.stock_lot_trace_references trace_reference
    WHERE trace_reference.lot_id = ${lotExpression} AND trace_reference.reference_type = '${kind}'`;
  const actual = kind === 'MP_LOT' ? `
    SELECT trace_lot.lot_code AS reference_value
    FROM public.of_output_lots trace_output
    JOIN public.production_material_debits trace_debit ON trace_debit.of_id = trace_output.of_id
    JOIN public.production_material_debit_sources trace_source ON trace_source.debit_id = trace_debit.id
    JOIN public.stock_movements trace_movement ON trace_movement.id = trace_source.stock_movement_id
    JOIN public.stock_reservations trace_reservation ON trace_reservation.id = trace_source.reservation_id
    JOIN public.lots trace_lot ON trace_lot.id = trace_reservation.lot_id
    WHERE trace_output.lot_id = ${lotExpression}
      AND trace_debit.compensates_id IS NULL
      AND NOT EXISTS(SELECT 1 FROM public.production_material_debits trace_correction
                     WHERE trace_correction.compensates_id = trace_debit.id)
      AND trace_movement.status = 'POSTED' AND trace_source.actual_qty > 0` : `
    SELECT trace_lot.lot_code AS reference_value
    FROM public.of_output_lots trace_output
    JOIN public.of_operations trace_operation ON trace_operation.of_id = trace_output.of_id
    JOIN public.subcontract_operation_completions trace_completion ON trace_completion.operation_id = trace_operation.id
    CROSS JOIN LATERAL jsonb_array_elements(CASE
      WHEN jsonb_typeof(trace_completion.evidence->'returns') = 'array' THEN trace_completion.evidence->'returns'
      ELSE '[]'::jsonb END) trace_return(value)
    JOIN public.reception_subcontract_origins trace_origin
      ON trace_origin.id::text = trace_return.value->>'originId'
     AND trace_origin.receipt_line_id::text = trace_return.value->>'receiptLineId'
    JOIN public.subcontract_work_packages trace_package ON trace_package.id = trace_origin.package_id
      AND trace_package.of_operation_id = trace_operation.id
    JOIN public.subcontract_purchase_origins trace_purchase ON trace_purchase.line_id = trace_package.supplier_order_line_id
      AND trace_purchase.operation_id = trace_operation.id
    JOIN public.reception_fournisseur_lignes trace_receipt ON trace_receipt.id = trace_origin.receipt_line_id
    JOIN public.lots trace_lot ON trace_lot.id = trace_receipt.lot_id
      AND trace_lot.id::text = trace_return.value->>'lotId'
    WHERE trace_output.lot_id = ${lotExpression}
      AND trace_purchase.preparation_snapshot->'purchase'->>'type_achat' = 'TRAITEMENT'
      AND trace_origin.quantity > 0`;
  return `${recorded}\nUNION ALL\n${actual}`;
}
