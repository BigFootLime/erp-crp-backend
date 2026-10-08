/** One MVCC snapshot supplies the candidate and its SHA. Numeric quantities stay
 * PostgreSQL text. Dense evidence is rejected rather than partially summed. */
export const MANUFACTURING_BASIS_CANDIDATE_SQL = `
WITH target AS (
  SELECT id,numero,article_id,piece_technique_id,piece_technique_version_id,statut,updated_at
  FROM public.ordres_fabrication WHERE id=$1::bigint
), active_operations AS (
  SELECT op.id,op.phase,op.status::text,op.revision_id,op.updated_at
  FROM public.of_operations op JOIN target ON target.id=op.of_id
  WHERE op.status::text<>'CANCELLED' AND (op.revision_id IS NULL OR EXISTS(
    SELECT 1 FROM public.of_revisions r WHERE r.id=op.revision_id AND r.of_id=op.of_id AND r.statut='ACTIVE'))
  ORDER BY op.phase,op.id LIMIT 1001
), final_operation AS (
  SELECT * FROM active_operations ORDER BY phase DESC,id DESC LIMIT 1
), declarations AS (
  SELECT d.id,d.operation_id,d.qty_good::text,d.qty_pending_control::text,d.qty_rework::text,
    d.compensates_id,d.declared_at
  FROM public.production_quantity_declarations d JOIN final_operation op ON op.id=d.operation_id
  WHERE d.of_id=$1::bigint ORDER BY d.declared_at,d.id LIMIT 10001
), margin AS (
  SELECT m.* FROM public.margin_recalculations m
  WHERE m.id=$2::uuid AND m.scope_type='OF' AND m.scope_ref=$1::text AND m.basis='ACTUAL'
), facts AS (
  SELECT jsonb_build_object('schema_version',1,
    'of',jsonb_build_object('id',t.id::text,'numero',t.numero,'article_id',t.article_id::text,
      'piece_technique_id',t.piece_technique_id::text,'piece_technique_version_id',t.piece_technique_version_id::text,
      'status',t.statut::text,'updated_at',t.updated_at::text),
    'operations',COALESCE((SELECT jsonb_agg(to_jsonb(op) ORDER BY op.phase,op.id) FROM active_operations op),'[]'::jsonb),
    'good_operation_id',(SELECT id::text FROM final_operation),
    'good_quantity',(SELECT sum(qty_good::numeric)::text FROM declarations),
    'pending_control_quantity',(SELECT sum(qty_pending_control::numeric)::text FROM declarations),
    'rework_quantity',(SELECT sum(qty_rework::numeric)::text FROM declarations),
    'declaration_count',(SELECT count(*) FROM declarations),
    'declaration_freshness',(SELECT max(declared_at)::text FROM declarations),
    'declaration_sha256',(SELECT encode(digest(COALESCE(jsonb_agg(to_jsonb(d) ORDER BY d.declared_at,d.id),'[]'::jsonb)::text,'sha256'),'hex') FROM declarations d),
    'dense_operations',(SELECT count(*)>1000 FROM active_operations),
    'dense_declarations',(SELECT count(*)>10000 FROM declarations),
    'margin_omitted',COALESCE((SELECT octet_length(m.input_snapshot::text)+octet_length(m.result_snapshot::text)>1048576 FROM margin m),false),
    'margin',(SELECT CASE WHEN octet_length(m.input_snapshot::text)+octet_length(m.result_snapshot::text)<=1048576
      THEN to_jsonb(m) ELSE NULL END FROM margin m)) AS source_snapshot
  FROM target t
)
SELECT source_snapshot,encode(digest(source_snapshot::text,'sha256'),'hex') AS source_sha256 FROM facts`;

export const MANUFACTURING_BASIS_READ_SQL = `SELECT id::text,of_id::text,margin_snapshot_id::text,
  quantity_good::text,total_cost_ht::text,currency,source_reliability,source_sha256,created_by,created_at::text,
  source_sha256=encode(digest(source_snapshot::text,'sha256'),'hex') AS source_valid
  FROM public.stock_valuation_manufacturing_bases WHERE of_id=$1::bigint`;

export const MANUFACTURING_BASIS_REQUEST_SQL = `SELECT id::text,of_id::text,margin_snapshot_id::text,
  quantity_good::text,total_cost_ht::text,currency,source_reliability,source_sha256,created_by,created_at::text,
  request_hash,source_sha256=encode(digest(source_snapshot::text,'sha256'),'hex') AS source_valid
  FROM public.stock_valuation_manufacturing_bases WHERE request_id=$1::uuid`;

export const MANUFACTURING_BASIS_INSERT_SQL = `INSERT INTO public.stock_valuation_manufacturing_bases
  (id,of_id,margin_snapshot_id,quantity_good,total_cost_ht,currency,source_reliability,
    source_snapshot,source_sha256,request_id,request_hash,created_by)
  VALUES($1::uuid,$2::bigint,$3::uuid,$4::numeric,$5::numeric,'EUR','DECLARED',$6::jsonb,$7,$8::uuid,$9,$10)
  RETURNING id::text,of_id::text,margin_snapshot_id::text,quantity_good::text,total_cost_ht::text,
    currency,source_reliability,source_sha256,created_by,created_at::text,true AS source_valid`;

export const MANUFACTURING_BASIS_ORDER_EXISTS_SQL = 'SELECT id FROM public.ordres_fabrication WHERE id=$1::bigint';
export const MANUFACTURING_BASIS_REQUEST_LOCK_SQL = "SELECT pg_advisory_xact_lock(hashtextextended('manufacturing-basis:'||$1::text,0))";
export const MANUFACTURING_BASIS_CONTROL_LOCK_SQL = 'SELECT singleton FROM public.stock_valuation_projector_control WHERE singleton FOR SHARE';
export const MANUFACTURING_BASIS_ORDER_LOCK_SQL = 'SELECT id FROM public.ordres_fabrication WHERE id=$1::bigint FOR UPDATE';
export const MANUFACTURING_BASIS_PROJECTED_SQL = `SELECT e.id FROM public.stock_valuation_entries e
  JOIN public.stock_valuation_movement_journal j ON j.movement_id=e.movement_id
  WHERE j.source_snapshot->>'source_document_type'='OF' AND j.source_snapshot->>'source_document_id'=$1::text
    AND j.source_snapshot->>'movement_type'='IN' LIMIT 1`;
export const MANUFACTURING_BASIS_OPERATIONS_LOCK_SQL = 'SELECT id FROM public.of_operations WHERE of_id=$1::bigint ORDER BY id FOR SHARE';
