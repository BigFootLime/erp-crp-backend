export const SUPPLIER_RECEIPT_COSTS_SQL = `
  SELECT concat('supplier-receipt:', receipt_line.id::text) AS key,
    'SUBCONTRACTING'::text AS category,
    CASE WHEN order_line.prix_unitaire_ht <= 0 AND order_line.frais_ht <= 0 THEN NULL
      ELSE round(receipt_line.qty_received * order_line.prix_unitaire_ht * (1-order_line.remise_pct/100.0)
        + CASE WHEN order_line.quantite>0 THEN order_line.frais_ht*receipt_line.qty_received/order_line.quantite ELSE 0 END,6)::text END AS amount_ht,
    'SUPPLIER_RECEPTION_ACTUAL'::text AS source_type, receipt.id::text AS source_ref,
    receipt_line.updated_at::text AS observed_at, 'DECLARED'::text AS source_reliability,
    supplier_order.devise::text AS currency, order_line.id::text AS order_line_id,
    receipt_line.qty_received::text AS receipt_quantity, order_line.unite::text AS purchase_unit
  FROM public.reception_fournisseur_lignes receipt_line
  JOIN public.receptions_fournisseurs receipt ON receipt.id=receipt_line.reception_id
  JOIN public.commande_fournisseur_ligne order_line ON order_line.id=receipt_line.commande_fournisseur_ligne_id
  JOIN public.commande_fournisseur supplier_order ON supplier_order.id=order_line.commande_id
  WHERE order_line.of_id=$1::bigint AND order_line.type IN ('SOUS_TRAITANCE','PRESTATION')
    AND order_line.statut_ligne<>'ANNULEE' AND receipt.status::text<>'CANCELLED' AND receipt_line.qty_received>0
  ORDER BY receipt_line.id
`;

// The approved match is immutable. Its supplier, receipt references and all
// archived evidence are checked again before using its amount for this OF.
export const SUPPLIER_APPROVED_INVOICE_COSTS_SQL = `
  SELECT concat('supplier-invoice-line:', invoice_line.id::text) AS key,
    'SUBCONTRACTING'::text AS category,
    (CASE WHEN invoice.document_type='CREDIT_NOTE' AND invoice.total_without_vat>=0
      THEN -invoice_line.net_amount ELSE invoice_line.net_amount END)::text AS amount_ht,
    'SUPPLIER_INVOICE_APPROVED_LINE'::text AS source_type, invoice_line.id::text AS source_ref,
    invoice.approved_at::text AS observed_at, 'VERIFIED'::text AS source_reliability,
    invoice.currency, order_line.id::text AS order_line_id, invoice.id::text AS invoice_id,
    invoice.document_type, invoice_line.quantity::text AS invoiced_quantity,
    invoice_line.unit_code AS invoice_unit, order_line.unite::text AS purchase_unit,
    supplier_order.devise::text AS purchase_currency,
    (invoice.fournisseur_id=supplier_order.fournisseur_id AND match.purchase_order_id=supplier_order.id
      AND match.outcome='MATCHED') AS supplier_matches,
    (cardinality(line_match.reception_line_ids)>0 AND NOT EXISTS (
      SELECT 1 FROM unnest(line_match.reception_line_ids) linked(id)
      LEFT JOIN public.reception_fournisseur_lignes receipt_line ON receipt_line.id=linked.id
      LEFT JOIN public.receptions_fournisseurs receipt ON receipt.id=receipt_line.reception_id
      WHERE receipt_line.id IS NULL OR receipt_line.commande_fournisseur_ligne_id<>order_line.id
        OR receipt.status::text='CANCELLED' OR receipt_line.qty_received<=0
    ) AND (invoice.document_type='CREDIT_NOTE' OR (invoice_line.quantity IS NOT NULL AND invoice_line.quantity>0
      AND invoice_line.quantity<=(SELECT COALESCE(sum(linked_receipt.qty_received),0)
        FROM public.reception_fournisseur_lignes linked_receipt WHERE linked_receipt.id=ANY(line_match.reception_line_ids))))) AS receipt_links_valid,
    (SELECT count(*)>0 AND bool_and(artifact.scan_status='CLEAN' AND artifact.ged_document_id IS NOT NULL
      AND artifact.ged_version_id IS NOT NULL AND artifact.archived_at IS NOT NULL)
      FROM public.supplier_invoice_artifacts artifact WHERE artifact.supplier_invoice_id=invoice.id) AS archive_ready,
    (abs(invoice.total_without_vat-(SELECT COALESCE(sum(all_lines.net_amount),0)
      FROM public.supplier_invoice_lines all_lines WHERE all_lines.supplier_invoice_id=invoice.id))<=0.01) AS header_allocated
  FROM public.supplier_invoices invoice
  JOIN LATERAL (
    SELECT version.* FROM public.supplier_invoice_match_versions version
    WHERE version.supplier_invoice_id=invoice.id AND version.created_at<=invoice.approved_at
    ORDER BY version.version DESC LIMIT 1
  ) match ON true
  JOIN public.supplier_invoice_line_matches line_match ON line_match.match_version_id=match.id
  JOIN public.supplier_invoice_lines invoice_line ON invoice_line.id=line_match.supplier_invoice_line_id
    AND invoice_line.supplier_invoice_id=invoice.id
  JOIN public.commande_fournisseur_ligne order_line ON order_line.id=line_match.purchase_order_line_id
  JOIN public.commande_fournisseur supplier_order ON supplier_order.id=order_line.commande_id
  WHERE order_line.of_id=$1::bigint AND order_line.type IN ('SOUS_TRAITANCE','PRESTATION')
    AND invoice.status IN ('APPROVED','ACCOUNTING_EXPORTED','CLOSED')
    AND invoice.approved_at IS NOT NULL AND invoice.approved_by IS NOT NULL
    AND EXISTS(SELECT 1 FROM public.supplier_invoice_decisions decision
      WHERE decision.supplier_invoice_id=invoice.id AND decision.decision='APPROVED'
        AND decision.actor_user_id=invoice.approved_by)
  ORDER BY order_line.id,invoice.approved_at,invoice_line.id
`;
