/** Aliases are static repository identifiers, never request input. Both the
 * approval preview and the margin reader use the entire invoice, not one OF. */
export function invoiceHeaderFactsSql(invoice: string,match: string): string {
  if(!/^[a-z_]+$/.test(invoice)||!/^[a-z_]+$/.test(match))throw new Error('INVOICE_HEADER_SQL_ALIAS_INVALID');
  return `jsonb_build_object(
    'invoice_id',${invoice}.id::text,'currency',${invoice}.currency,'document_type',${invoice}.document_type,
    'total_ht',${invoice}.total_without_vat::text,'match_version_id',${match}.id::text,
    'match_purchase_order_id',${match}.purchase_order_id::text,'match_outcome',${match}.outcome,
    'supplier_matches',COALESCE(${invoice}.fournisseur_id=(SELECT supplier.fournisseur_id
      FROM public.commande_fournisseur supplier WHERE supplier.id=${match}.purchase_order_id),false),
    'lines',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',all_lines.id::text,
      'position',all_lines.position,'net_ht',all_lines.net_amount::text,
      'purchase_order_line_id',CASE WHEN matched_order.commande_id=${match}.purchase_order_id
        AND matched_order.statut_ligne<>'ANNULEE' THEN all_matches.purchase_order_line_id::text ELSE NULL END)
        ORDER BY all_lines.position,all_lines.id)
      FROM public.supplier_invoice_lines all_lines
      LEFT JOIN public.supplier_invoice_line_matches all_matches ON all_matches.supplier_invoice_line_id=all_lines.id
        AND all_matches.match_version_id=${match}.id
      LEFT JOIN public.commande_fournisseur_ligne matched_order ON matched_order.id=all_matches.purchase_order_line_id
      WHERE all_lines.supplier_invoice_id=${invoice}.id),'[]'::jsonb),
    'artifacts',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',artifact.id::text,
      'sha256',artifact.content_sha256::text,'document_id',artifact.ged_document_id::text,
      'version_id',artifact.ged_version_id::text,'scan_status',artifact.scan_status,
      'archived_at',to_char(artifact.archived_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
      ORDER BY artifact.id) FROM public.supplier_invoice_artifacts artifact
      WHERE artifact.supplier_invoice_id=${invoice}.id),'[]'::jsonb))`;
}

export const SUPPLIER_INVOICE_HEADER_SOURCE_SQL=`
SELECT si.id::text,si.row_version,${invoiceHeaderFactsSql('si','match')} AS facts
FROM public.supplier_invoices si
LEFT JOIN LATERAL (SELECT version.* FROM public.supplier_invoice_match_versions version
  WHERE version.supplier_invoice_id=si.id ORDER BY version.version DESC LIMIT 1) match ON true
WHERE si.id=$1::uuid`;
