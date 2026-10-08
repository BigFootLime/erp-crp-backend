import { invoiceHeaderFactsSql } from '../../supplier-invoices/supplier-invoice-header-source.sql';

export const SUPPLIER_RECEIPT_COSTS_SQL = `
  WITH receipts AS (
    SELECT receipt_line.id,receipt.id AS receipt_id,receipt_line.updated_at,
      receipt_line.qty_received,order_line.id AS order_line_id,order_line.unite,
      order_line.quantite,order_line.prix_unitaire_ht,order_line.remise_pct,order_line.frais_ht,
      supplier_order.frais_port_ht,supplier_order.devise,
      COALESCE(sum(receipt_line.qty_received) OVER (PARTITION BY order_line.id ORDER BY receipt_line.id
        ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0) AS before_quantity
    FROM public.reception_fournisseur_lignes receipt_line
    JOIN public.receptions_fournisseurs receipt ON receipt.id=receipt_line.reception_id
    JOIN public.commande_fournisseur_ligne order_line ON order_line.id=receipt_line.commande_fournisseur_ligne_id
    JOIN public.commande_fournisseur supplier_order ON supplier_order.id=order_line.commande_id
    WHERE order_line.of_id=$1::bigint AND order_line.type IN ('SOUS_TRAITANCE','PRESTATION')
      AND order_line.statut_ligne<>'ANNULEE' AND receipt.status::text<>'CANCELLED' AND receipt_line.qty_received>0
  ), qualified AS (
    SELECT receipts.*,CASE
      WHEN ARRAY[quantite::text,qty_received::text,before_quantity::text,prix_unitaire_ht::text,
        remise_pct::text,frais_ht::text,frais_port_ht::text] && ARRAY['NaN','Infinity','-Infinity']
        THEN 'Montants ou quantités non finis.'
      WHEN frais_port_ht IS NULL OR frais_port_ht<>0 THEN 'Transport de commande non réparti entre lignes : coût à confirmer.'
      WHEN quantite IS NULL OR quantite<=0 THEN 'Quantité commandée manquante ou invalide pour répartir le forfait.'
      WHEN prix_unitaire_ht IS NULL OR prix_unitaire_ht<0 OR frais_ht IS NULL OR frais_ht<0
        OR remise_pct IS NULL OR remise_pct<0 OR remise_pct>100 THEN 'Prix, remise ou forfait de commande invalide.'
      WHEN prix_unitaire_ht=0 AND frais_ht=0 THEN 'Gratuité non justifiée : facture contrôlée nécessaire.'
      ELSE NULL END AS issue
    FROM receipts
  )
  SELECT concat('supplier-receipt:',id::text) AS key,'SUBCONTRACTING'::text AS category,
    CASE WHEN issue IS NULL THEN (round(qty_received*prix_unitaire_ht*(1-remise_pct/100.0),6)
      + round(frais_ht*LEAST(before_quantity+qty_received,quantite)/NULLIF(quantite,0),6)
      - round(frais_ht*LEAST(before_quantity,quantite)/NULLIF(quantite,0),6))::text ELSE NULL END AS amount_ht,
    'SUPPLIER_RECEPTION_ACTUAL'::text AS source_type,receipt_id::text AS source_ref,
    updated_at::text AS observed_at,CASE WHEN issue IS NULL THEN 'DECLARED' ELSE 'UNKNOWN' END AS source_reliability,
    devise::text AS currency,order_line_id::text,qty_received::text AS receipt_quantity,unite::text AS purchase_unit,
    COALESCE(issue,'Estimation HT de commande ; forfait cumulé plafonné, arrondi à six décimales et attribué par identifiant de réception.') AS definition
  FROM qualified ORDER BY id
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
    (invoice.total_without_vat=(SELECT COALESCE(sum(all_lines.net_amount),0)
      FROM public.supplier_invoice_lines all_lines WHERE all_lines.supplier_invoice_id=invoice.id)) AS header_allocated,
    invoice_line.id::text AS invoice_line_id,invoice.total_without_vat::text AS invoice_total_ht,
    CASE WHEN row_number() OVER(PARTITION BY invoice.id ORDER BY order_line.id,invoice_line.id)=1
      THEN ${invoiceHeaderFactsSql('invoice','match')} ELSE NULL END AS invoice_header_facts,
    CASE WHEN row_number() OVER(PARTITION BY invoice.id ORDER BY order_line.id,invoice_line.id)=1
      THEN approval.snapshot->'header_allocation' ELSE NULL END AS approved_header_allocation
  FROM public.supplier_invoices invoice
  JOIN LATERAL (
    SELECT version.* FROM public.supplier_invoice_match_versions version
    WHERE version.supplier_invoice_id=invoice.id AND version.created_at<=invoice.approved_at
    ORDER BY version.version DESC LIMIT 1
  ) match ON true
  JOIN LATERAL (
    SELECT decision.snapshot FROM public.supplier_invoice_decisions decision
    WHERE decision.supplier_invoice_id=invoice.id AND decision.decision='APPROVED'
      AND decision.to_status='APPROVED' AND decision.actor_user_id=invoice.approved_by
      AND decision.created_at<=invoice.approved_at
    ORDER BY decision.created_at DESC,decision.id DESC LIMIT 1
  ) approval ON true
  JOIN public.supplier_invoice_line_matches line_match ON line_match.match_version_id=match.id
  JOIN public.supplier_invoice_lines invoice_line ON invoice_line.id=line_match.supplier_invoice_line_id
    AND invoice_line.supplier_invoice_id=invoice.id
  JOIN public.commande_fournisseur_ligne order_line ON order_line.id=line_match.purchase_order_line_id
  JOIN public.commande_fournisseur supplier_order ON supplier_order.id=order_line.commande_id
  WHERE order_line.of_id=$1::bigint AND order_line.type IN ('SOUS_TRAITANCE','PRESTATION')
    AND invoice.status IN ('APPROVED','ACCOUNTING_EXPORTED','CLOSED')
    AND invoice.approved_at IS NOT NULL AND invoice.approved_by IS NOT NULL
  ORDER BY order_line.id,invoice.approved_at,invoice_line.id
`;
