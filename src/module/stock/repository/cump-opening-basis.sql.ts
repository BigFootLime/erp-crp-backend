export const OPENING_BASIS_CANDIDATE_SQL=`SELECT proof AS source_snapshot,
  encode(digest(proof::text,'sha256'),'hex') AS source_sha256
  FROM (SELECT public.fn_stock_opening_candidate_1004($1::uuid,$2::text) AS proof
    FROM public.articles a WHERE a.id=$1::uuid) p`;
export const OPENING_BASIS_DOCUMENTS_SQL=`SELECT sd.id::text AS id,sd.original_name AS name,sd.sha256
  FROM public.stock_documents sd WHERE sd.removed_at IS NULL AND sd.sha256 ~ '^[0-9a-f]{64}$'
    AND EXISTS(SELECT 1 FROM public.article_documents ad WHERE ad.article_id=$1::uuid
      AND ad.document_id=sd.id AND ad.is_active) ORDER BY sd.id LIMIT 101`;
export const OPENING_BASIS_DOCUMENT_LOCK_SQL=`SELECT sd.id::text AS id,sd.original_name AS name,sd.sha256
  FROM public.stock_documents sd JOIN public.article_documents ad ON ad.document_id=sd.id
  WHERE ad.article_id=$1::uuid AND sd.id=$2::uuid AND ad.is_active AND sd.removed_at IS NULL
    AND sd.sha256=$3::text FOR SHARE OF sd,ad`;
const FIELDS=`id::text,article_id::text,owner_key,stock_unit,currency,quantity::text,total_value_ht::text,
  document_id::text,document_sha256,source_reliability,source_sha256,created_by,created_at::text,
  source_sha256=encode(digest(source_snapshot::text,'sha256'),'hex') AS source_valid`;
export const OPENING_BASIS_READ_SQL=`SELECT ${FIELDS} FROM public.stock_valuation_opening_bases
  WHERE article_id=$1::uuid AND stock_unit=$2::text AND owner_key='COMPANY' AND currency='EUR'`;
export const OPENING_BASIS_REQUEST_SQL=`SELECT ${FIELDS},request_hash FROM public.stock_valuation_opening_bases
  WHERE request_id=$1::uuid`;
export const OPENING_BASIS_CONTROL_LOCK_SQL=`SELECT mode,initialized,last_sequence::text,reporting_currency
  FROM public.stock_valuation_projector_control WHERE singleton FOR SHARE`;
export const OPENING_BASIS_REQUEST_LOCK_SQL=`SELECT pg_advisory_xact_lock(hashtextextended('stock:opening-basis:'||$1::text,0))`;
export const OPENING_BASIS_INSERT_SQL=`INSERT INTO public.stock_valuation_opening_bases
  (id,article_id,stock_unit,quantity,total_value_ht,document_id,document_sha256,source_snapshot,source_sha256,
    request_id,request_hash,created_by)
  VALUES($1::uuid,$2::uuid,$3::text,$4::numeric,$5::numeric,$6::uuid,$7::text,$8::jsonb,
    encode(digest(($8::jsonb)::text,'sha256'),'hex'),$9::uuid,$10::text,$11::integer) RETURNING ${FIELDS}`;
export const OPENING_BASIS_INTERNAL_SQL=`SELECT b.id::text,b.total_value_ht::text,b.source_sha256,
  public.fn_stock_opening_entry_basis_1004(b.article_id,b.owner_key,b.stock_unit,b.currency,$5::numeric,
    b.total_value_ht,jsonb_build_object('opening_basis_id',b.id::text,'opening_basis_sha256',b.source_sha256,
      'opening_ids',$6::jsonb)) AS source_valid
  FROM public.stock_valuation_opening_bases b WHERE b.article_id=$1::uuid AND b.owner_key=$2::text
    AND b.stock_unit=$3::text AND b.currency=$4::text`;
