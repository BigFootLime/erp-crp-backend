import { invoiceHeaderFactsSql } from './supplier-invoice-header-source.sql';

// A single repeatable-read snapshot covers fiscal approval, receipt proofs,
// immutable postings and current physical stock. Monetary order fields are
// deliberately absent: only the receipt journal can supply the old cost.
export const MATERIAL_INVOICE_SOURCE_SQL = `
SELECT si.id::text,si.row_version,si.fournisseur_id::text AS supplier_id,si.currency,
  si.document_type,match.id::text AS match_id,match.purchase_order_id::text AS order_id,
  (si.status IN('APPROVED','ACCOUNTING_EXPORTED','CLOSED') AND si.approved_at IS NOT NULL
    AND si.approved_by IS NOT NULL AND approval.id IS NOT NULL) AS approved,
  approval.id::text AS approval_id,approval.snapshot->'header_allocation' AS header_allocation,
  CASE WHEN (SELECT count(*) FROM public.supplier_invoice_lines size_lines WHERE size_lines.supplier_invoice_id=si.id)<=2000
    AND (SELECT count(*) FROM public.supplier_invoice_artifacts size_artifacts WHERE size_artifacts.supplier_invoice_id=si.id)<=2000
    THEN ${invoiceHeaderFactsSql('si','match')} END AS header_facts
FROM public.supplier_invoices si
LEFT JOIN LATERAL (SELECT v.* FROM public.supplier_invoice_match_versions v
  WHERE v.supplier_invoice_id=si.id AND v.created_at<=si.approved_at
  ORDER BY v.version DESC LIMIT 1) match ON true
LEFT JOIN LATERAL (SELECT d.id,d.snapshot FROM public.supplier_invoice_decisions d
  WHERE d.supplier_invoice_id=si.id AND d.decision='APPROVED' AND d.to_status='APPROVED'
    AND d.actor_user_id=si.approved_by AND d.created_at<=si.approved_at
  ORDER BY d.created_at DESC,d.id DESC LIMIT 1) approval ON true
WHERE si.id=$1::uuid`;

export const MATERIAL_INVOICE_LINES_SQL = `
SELECT il.id::text,il.position,il.quantity::text,il.unit_code AS unit,
  lm.purchase_order_line_id::text AS order_line_id,lm.reception_line_ids::text[] AS receipt_ids,
  (cl.commande_id=$3::uuid AND cl.statut_ligne<>'ANNULEE') AS link_valid,
  EXISTS(SELECT 1 FROM public.supplier_invoices other
    JOIN LATERAL (SELECT v.id FROM public.supplier_invoice_match_versions v
      WHERE v.supplier_invoice_id=other.id AND v.created_at<=other.approved_at
      ORDER BY v.version DESC LIMIT 1) other_match ON true
    JOIN public.supplier_invoice_line_matches other_line ON other_line.match_version_id=other_match.id
    WHERE other.id<>$1::uuid AND other.status IN('APPROVED','ACCOUNTING_EXPORTED','CLOSED')
      AND other_line.purchase_order_line_id=lm.purchase_order_line_id
      AND other_line.reception_line_ids && lm.reception_line_ids) AS other_invoice
FROM public.supplier_invoice_lines il
JOIN public.supplier_invoice_line_matches lm ON lm.supplier_invoice_line_id=il.id AND lm.match_version_id=$2::uuid
JOIN public.commande_fournisseur_ligne cl ON cl.id=lm.purchase_order_line_id
WHERE il.supplier_invoice_id=$1::uuid AND cl.type='MATIERE'
ORDER BY il.position,il.id LIMIT 501`;

export const MATERIAL_INVOICE_RECEIPTS_SQL = `
WITH bounded AS (
  SELECT s.id::text AS receipt_stock_id,s.reception_id::text,s.reception_line_id::text AS receipt_line_id,
    s.stock_movement_id::text AS movement_id,s.qty::text AS receipt_quantity,
    COALESCE(r.status::text<>'CANCELLED',false) AS receipt_active,
    a.source_snapshot AS acquisition_snapshot,a.source_sha256 AS acquisition_sha256,
    COALESCE(a.source_sha256=encode(digest(a.source_snapshot::text,'sha256'),'hex'),false) AS acquisition_valid,
    j.sequence::text,j.article_id::text,j.source_snapshot,j.source_sha256,
    COALESCE(j.source_sha256=encode(digest(j.source_snapshot::text,'sha256'),'hex'),false) AS source_valid,
    e.id::text AS entry_id,e.owner_key,e.stock_unit,e.currency,e.quantity_delta::text,
    e.movement_value::text,e.reliability,e.source_snapshot AS entry_snapshot,e.source_sha256 AS entry_sha256,
    COALESCE(e.source_sha256=encode(digest(e.source_snapshot::text,'sha256'),'hex'),false) AS entry_valid,
    COALESCE(octet_length(a.source_snapshot::text),0)+COALESCE(octet_length(j.source_snapshot::text),0)
      +COALESCE(octet_length(e.source_snapshot::text),0) AS bytes
  FROM public.reception_fournisseur_stock_receipts s
  LEFT JOIN public.receptions_fournisseurs r ON r.id=s.reception_id
  LEFT JOIN public.stock_valuation_acquisition_sources a ON a.movement_id=s.stock_movement_id
  LEFT JOIN public.stock_valuation_movement_journal j ON j.movement_id=s.stock_movement_id
  LEFT JOIN public.stock_valuation_entries e ON e.movement_id=s.stock_movement_id
    AND e.article_id=j.article_id AND e.owner_key='COMPANY' AND e.kind='RECEIPT'
  WHERE s.reception_line_id=ANY($1::uuid[]) ORDER BY s.id LIMIT 501
), budget AS (SELECT b.*,sum(bytes) OVER(ORDER BY receipt_stock_id) AS total_bytes FROM bounded b)
SELECT receipt_stock_id,reception_id,receipt_line_id,movement_id,receipt_quantity,receipt_active,
  acquisition_sha256,acquisition_valid,sequence,article_id,source_sha256,source_valid,
  entry_id,owner_key,stock_unit,currency,quantity_delta,movement_value,reliability,entry_sha256,entry_valid,
  total_bytes<=2097152 AS proof_complete,
  CASE WHEN total_bytes<=2097152 THEN acquisition_snapshot END AS acquisition_snapshot,
  CASE WHEN total_bytes<=2097152 THEN source_snapshot END AS source_snapshot,
  CASE WHEN total_bytes<=2097152 THEN entry_snapshot END AS entry_snapshot
FROM budget ORDER BY receipt_stock_id`;

export const MATERIAL_INVOICE_LOTS_SQL = `
SELECT l.id::text AS lot_id,l.article_id::text,l.lot_code,l.client_proprietaire_id AS owner_client_id,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('batch_id',b.id::text,'level_id',s.id::text,
    'article_id',s.article_id::text,'unit',COALESCE(u.code,a.unite),
    'quantity_total',b.qty_total::text,'quantity_depreciated',b.qty_depreciated::text) ORDER BY b.id)
    FROM (SELECT * FROM public.stock_batches WHERE lot_id=l.id ORDER BY id LIMIT 501) b
    JOIN public.stock_levels s ON s.id=b.stock_level_id
    JOIN public.articles a ON a.id=s.article_id LEFT JOIN public.units u ON u.id=s.unit_id
    WHERE b.lot_id=l.id),'[]'::jsonb) AS batches,
  EXISTS(SELECT 1 FROM public.stock_valuation_opening_quantities o
    WHERE o.source_snapshot->>'lot_id'=l.id::text
      AND CASE WHEN o.source_snapshot->>'quantity_total' ~ '^[0-9]+([.][0-9]+)?$'
        THEN (o.source_snapshot->>'quantity_total')::numeric>0 ELSE true END) AS has_opening
FROM public.lots l WHERE l.id=ANY($1::uuid[]) ORDER BY l.id LIMIT 501`;

// Existing lot/movement indexes identify postings. Their immutable snapshots
// are then checked again; a missing capture is returned rather than ignored.
export const MATERIAL_INVOICE_TRACE_SQL = `
WITH ids AS (SELECT DISTINCT ml.movement_id FROM public.stock_movement_lines ml
  JOIN public.stock_movements m ON m.id=ml.movement_id
  WHERE ml.lot_id=ANY($1::uuid[]) AND m.status::text IN('POSTED','COMPENSATED')
  ORDER BY ml.movement_id LIMIT 2001), bounded AS (
  SELECT i.movement_id::text,j.article_id::text,j.sequence::text,j.source_sha256,
    j.source_snapshot,COALESCE(j.source_sha256=encode(digest(j.source_snapshot::text,'sha256'),'hex'),false) AS source_valid,
    sum(COALESCE(octet_length(j.source_snapshot::text),0)) OVER(ORDER BY i.movement_id) AS total_bytes
  FROM ids i LEFT JOIN public.stock_valuation_movement_journal j ON j.movement_id=i.movement_id
)
SELECT movement_id,article_id,sequence,source_sha256,source_valid,total_bytes<=2097152 AS proof_complete,
  CASE WHEN total_bytes<=2097152 THEN source_snapshot END AS source_snapshot
FROM bounded ORDER BY movement_id`;

export const MATERIAL_INVOICE_BALANCES_SQL = `
SELECT s.article_id,s.unit,public.fn_stock_value_candidate_1007(s.article_id,s.unit) AS source_snapshot
FROM jsonb_to_recordset($1::jsonb) AS s(article_id uuid,unit text)
ORDER BY s.article_id,s.unit`;
