// Shared by the receipt and purchase-order closure guards. The recorded quantity
// and stock receipts use the receipt unit, even when the movement uses mm.
export const fullyStockedMaterialSql = `
  l.processing_policy='STANDARD'
  AND l.stock_managed AND l.receipt_tool_id IS NULL
  AND a.article_category='matiere' AND lot.lot_status='LIBERE'
  AND NOT l.processing_reconciliation_required
  AND l.qty_received > 0
  AND NOT EXISTS (
    SELECT 1 FROM public.non_conformity nc
    WHERE (nc.reception_ligne_id=l.id OR nc.lot_id=lot.id)
      AND nc.status NOT IN ('CLOSED','CANCELLED')
  )
  AND (NOT l.receipt_quality_required OR EXISTS (
    SELECT 1 FROM public.quality_control qc
    WHERE qc.reception_ligne_id=l.id AND qc.lot_id=lot.id
      AND qc.operator_receipt_control AND qc.status='VALIDATED' AND qc.verdict='CONFORME'
  ))
  AND l.qty_received = COALESCE((
    SELECT sum(sr.qty)
    FROM public.reception_fournisseur_stock_receipts sr
    JOIN public.stock_movements movement ON movement.id=sr.stock_movement_id AND movement.status='POSTED'
    WHERE sr.reception_line_id=l.id
  ), 0)
`;
