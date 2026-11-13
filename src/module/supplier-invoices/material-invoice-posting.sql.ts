export const MATERIAL_SOURCE_SQL=`SELECT public.fn_supplier_invoice_sources_1022($1::uuid) AS source`;
const FIELDS=`id::text,invoice_id::text,request_hash,proposal_source_sha256 AS source_sha256,
  source_sha256=encode(digest(source_snapshot::text,'sha256'),'hex') AS source_valid,
  source_snapshot->'response' AS response`;
export const MATERIAL_POSTING_REPLAY_SQL=`SELECT ${FIELDS} FROM public.stock_valuation_invoice_reconciliations WHERE request_id=$1::uuid`;
export const MATERIAL_POSTING_HISTORY_SQL=`SELECT ${FIELDS} FROM public.stock_valuation_invoice_reconciliations WHERE invoice_id=$1::uuid`;
export const MATERIAL_POSTING_REQUEST_LOCK_SQL=`SELECT pg_advisory_xact_lock(hashtextextended('stock:invoice-intent:'||$1::text,0))`;
export const MATERIAL_POSTING_PROJECTOR_LOCK_SQL=`SELECT pg_advisory_xact_lock(hashtextextended('stock:cump-projector:1',0))`;
export const MATERIAL_POSTING_CONTROL_SQL=`SELECT mode,initialized,reporting_currency,formula_version,last_sequence::text
 FROM public.stock_valuation_projector_control WHERE singleton FOR UPDATE`;
export const MATERIAL_POSTING_INVOICE_LOCK_SQL=`SELECT id FROM public.supplier_invoices WHERE id=$1::uuid FOR SHARE`;
export const MATERIAL_POSTING_FISCAL_BARRIER_SQL=`LOCK TABLE public.supplier_invoice_artifacts,public.supplier_invoice_lines,
 public.supplier_invoice_line_matches,public.supplier_invoice_match_versions,public.supplier_invoice_decisions IN SHARE MODE`;
export const MATERIAL_POSTING_INSERT_SQL=`INSERT INTO public.stock_valuation_invoice_reconciliations
 (id,invoice_id,request_id,request_hash,proposal_source_sha256,source_snapshot,source_sha256,created_by)
 VALUES($1::uuid,$2::uuid,$3::uuid,$4::text,$5::text,$6::jsonb,encode(digest(($6::jsonb)::text,'sha256'),'hex'),$7::integer)
 RETURNING id::text,source_sha256`;
export const MATERIAL_POSTING_SCOPE_SQL=`INSERT INTO public.stock_valuation_invoice_scope_adjustments
 (entry_id,reconciliation_id,article_id,stock_unit,previous_entry_id,quantity,previous_value_ht,stock_variance_ht,consumed_variance_ht,total_value_ht)
 VALUES($1::uuid,$2::uuid,$3::uuid,$4::text,$5::uuid,$6::numeric,$7::numeric,$8::numeric,$9::numeric,$10::numeric)`;
export const MATERIAL_POSTING_ENTRY_SQL=`INSERT INTO public.stock_valuation_entries
 (id,article_id,owner_key,stock_unit,currency,source_sequence,kind,formula_version,quantity_delta,value_delta,
 movement_value,reliability,source_snapshot,source_sha256,issues,invoice_reconciliation_id)
 VALUES($1::uuid,$2::uuid,'COMPANY',$3::text,'EUR',$4::bigint,'INVOICE_ADJUSTMENT','CERP-CUMP-1.0.0',0,
 $5::numeric,$6::numeric,'DECLARED',$7::jsonb,encode(digest(($7::jsonb)::text,'sha256'),'hex'),'[]'::jsonb,$8::uuid)`;
export const MATERIAL_POSTING_CONSUMPTION_SQL=`INSERT INTO public.stock_valuation_invoice_consumption_adjustments
 (reconciliation_id,invoice_line_id,lot_id,movement_id,line_id,of_id,quantity,amount_ht,stock_sha256)
 SELECT $1::uuid,c.invoice_line_id,c.lot_id,c.movement_id,c.line_id,c.of_id,c.quantity,c.amount_ht,c.stock_sha256
 FROM jsonb_to_recordset($2::jsonb) AS c(invoice_line_id uuid,lot_id uuid,movement_id uuid,line_id uuid,of_id bigint,
 quantity numeric,amount_ht numeric,stock_sha256 text)`;
