export const VALUE_ADJUSTMENT_CANDIDATE_SQL=`SELECT proof AS source_snapshot,
  encode(digest(proof::text,'sha256'),'hex') AS source_sha256
  FROM (SELECT public.fn_stock_value_candidate_1007($1::uuid,$2::text) AS proof
    FROM public.articles a WHERE a.id=$1::uuid) p`;
export const VALUE_ADJUSTMENT_REQUEST_LOCK_SQL=`SELECT pg_advisory_xact_lock(hashtextextended('stock:value-adjustment:'||$1::text,0))`;
export const VALUE_ADJUSTMENT_PROJECTOR_LOCK_SQL=`SELECT pg_advisory_xact_lock(hashtextextended('stock:cump-projector:1',0))`;
export const VALUE_ADJUSTMENT_CONTROL_LOCK_SQL=`SELECT mode,reporting_currency,formula_version,initialized,last_sequence::text
  FROM public.stock_valuation_projector_control WHERE singleton FOR UPDATE`;
const FIELDS=`id::text,entry_id::text,article_id::text,owner_key,stock_unit,currency,quantity::text,
  previous_value_ht::text,total_value_ht::text,value_delta::text,previous_entry_id::text,
  document_id::text,document_sha256,source_reliability,source_sha256,created_by,created_at::text,
  source_sha256=encode(digest(source_snapshot::text,'sha256'),'hex') AS source_valid`;
export const VALUE_ADJUSTMENT_REQUEST_SQL=`SELECT ${FIELDS},request_hash
  FROM public.stock_valuation_value_adjustments WHERE request_id=$1::uuid`;
export const VALUE_ADJUSTMENT_LIST_SQL=`SELECT ${FIELDS} FROM public.stock_valuation_value_adjustments
  WHERE article_id=$1::uuid AND stock_unit=$2::text ORDER BY created_at DESC,id DESC LIMIT 101`;
export const VALUE_ADJUSTMENT_INSERT_SQL=`INSERT INTO public.stock_valuation_value_adjustments
  (id,entry_id,article_id,stock_unit,quantity,previous_value_ht,total_value_ht,value_delta,previous_entry_id,
    document_id,document_sha256,source_snapshot,source_sha256,request_id,request_hash,created_by)
  VALUES($1::uuid,$2::uuid,$3::uuid,$4::text,$5::numeric,$6::numeric,$7::numeric,$8::numeric,$9::uuid,
    $10::uuid,$11::text,$12::jsonb,encode(digest(($12::jsonb)::text,'sha256'),'hex'),$13::uuid,$14::text,$15::integer)
  RETURNING ${FIELDS}`;
export const VALUE_ADJUSTMENT_ENTRY_SQL=`INSERT INTO public.stock_valuation_entries
  (id,article_id,owner_key,stock_unit,currency,source_sequence,kind,formula_version,quantity_delta,value_delta,
    movement_value,reliability,source_snapshot,source_sha256,issues,value_adjustment_id)
  VALUES($1::uuid,$2::uuid,'COMPANY',$3::text,'EUR',$4::bigint,'VALUE_ADJUSTMENT','CERP-CUMP-1.0.0',0,
    $5::numeric,$6::numeric,'DECLARED',$7::jsonb,encode(digest(($7::jsonb)::text,'sha256'),'hex'),$8::jsonb,$9::uuid)
  RETURNING id::text`;
