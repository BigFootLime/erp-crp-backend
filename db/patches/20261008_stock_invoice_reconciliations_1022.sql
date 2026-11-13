-- Explicit sourced invoice corrections; no activation or historical backfill.
BEGIN;
SET LOCAL lock_timeout='10s';

CREATE FUNCTION public.fn_stock_invoice_physical_1022(article uuid, unit_code text) RETURNS jsonb
LANGUAGE sql STABLE AS $$
WITH live AS (
  SELECT s.id AS id,s.id AS stock_level_id,NULL::uuid AS stock_batch_id,s.article_id,NULL::timestamptz AS captured_at,
    true AS source_valid,jsonb_build_object('schema_version',1,'kind','LEVEL','article_id',s.article_id::text,
      'stock_level_id',s.id::text,'stock_batch_id',NULL,'stock_unit',COALESCE(u.code,a.unite),
      'quantity_total',s.qty_total::text,'quantity_depreciated',s.qty_depreciated::text,'owner_client_id',NULL) AS source_snapshot
  FROM public.stock_levels s JOIN public.articles a ON a.id=s.article_id LEFT JOIN public.units u ON u.id=s.unit_id WHERE s.article_id=article
  UNION ALL
  SELECT b.id,s.id,b.id,s.article_id,NULL::timestamptz,l.id IS NOT NULL,
    jsonb_build_object('schema_version',1,'kind','BATCH','article_id',s.article_id::text,'stock_level_id',s.id::text,
      'stock_batch_id',b.id::text,'stock_unit',COALESCE(u.code,a.unite),'quantity_total',b.qty_total::text,
      'quantity_depreciated',b.qty_depreciated::text,'owner_client_id',l.client_proprietaire_id)
  FROM public.stock_batches b JOIN public.stock_levels s ON s.id=b.stock_level_id JOIN public.articles a ON a.id=s.article_id
    LEFT JOIN public.units u ON u.id=s.unit_id LEFT JOIN public.lots l ON l.id=b.lot_id WHERE s.article_id=article
), current_observations AS (
  SELECT live.*,encode(digest(source_snapshot::text,'sha256'),'hex') AS source_sha256 FROM live
), raw AS MATERIALIZED (
  SELECT o.*,public.fn_stock_opening_scope_1004(o.source_snapshot->>'stock_unit') AS unit,
    o.source_snapshot->>'owner_client_id' AS owner,
    CASE WHEN length(o.source_snapshot->>'quantity_total')<=80
      AND o.source_snapshot->>'quantity_total' ~ '^-?[0-9]+(\.[0-9]{1,12})?$'
      THEN (o.source_snapshot->>'quantity_total')::numeric END AS total,
    CASE WHEN length(o.source_snapshot->>'quantity_depreciated')<=80
      AND o.source_snapshot->>'quantity_depreciated' ~ '^[0-9]+(\.[0-9]{1,12})?$'
      THEN (o.source_snapshot->>'quantity_depreciated')::numeric END AS depreciated,
    o.source_valid AND o.source_sha256=encode(digest(o.source_snapshot::text,'sha256'),'hex')
      AND o.source_snapshot->'schema_version'='1'::jsonb
      AND o.source_snapshot->>'article_id'=o.article_id::text
      AND o.source_snapshot->>'stock_level_id'=o.stock_level_id::text
      AND o.source_snapshot->>'stock_batch_id' IS NOT DISTINCT FROM o.stock_batch_id::text
      AND o.source_snapshot->>'kind'=(CASE WHEN o.stock_batch_id IS NULL THEN 'LEVEL' ELSE 'BATCH' END)
      AND o.source_snapshot ? 'stock_batch_id'
      AND jsonb_typeof(o.source_snapshot->'stock_unit')='string'
      AND jsonb_typeof(o.source_snapshot->'quantity_total')='string'
      AND jsonb_typeof(o.source_snapshot->'quantity_depreciated')='string'
      AND jsonb_typeof(o.source_snapshot->'owner_client_id') IN('string','null') AS proof_valid
  FROM current_observations o WHERE o.article_id=article ORDER BY o.id LIMIT 10001
), levels AS (
  SELECT l.*,count(b.id) AS batches_count,COALESCE(sum(b.total),0) AS batches_total,
    COALESCE(sum(b.depreciated),0) AS batches_depreciated,
    COALESCE(sum(b.total-b.depreciated) FILTER(WHERE b.owner IS NOT NULL),0) AS client_quantity
  FROM raw l LEFT JOIN raw b ON b.stock_level_id=l.stock_level_id AND b.stock_batch_id IS NOT NULL
  WHERE l.stock_batch_id IS NULL
  GROUP BY l.id,l.stock_level_id,l.stock_batch_id,l.article_id,l.captured_at,l.source_snapshot,
    l.source_sha256,l.unit,l.owner,l.total,l.depreciated,l.proof_valid,l.source_valid
), totals AS (
  SELECT COALESCE(sum(total-depreciated-client_quantity) FILTER(WHERE unit=unit_code),0) AS quantity FROM levels
), checks AS (
  SELECT count(*) BETWEEN 1 AND 10000
    AND count(*) FILTER(WHERE unit=unit_code)>0
    AND COALESCE(bool_and(COALESCE(proof_valid AND unit IS NOT NULL AND length(unit)<=32
      AND total IS NOT NULL AND depreciated IS NOT NULL AND total>=0 AND depreciated<=total
      AND total<1e26 AND depreciated<1e26
      AND (stock_batch_id IS NOT NULL OR owner IS NULL)
      AND (owner IS NULL OR(length(owner) BETWEEN 1 AND 255 AND owner=btrim(owner)
        AND owner !~ '[[:cntrl:]]')),false)),false)
    AND NOT EXISTS(SELECT 1 FROM raw b WHERE b.stock_batch_id IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM raw l WHERE l.stock_batch_id IS NULL
        AND l.stock_level_id=b.stock_level_id AND l.unit=b.unit))
    AND NOT EXISTS(SELECT 1 FROM levels l WHERE l.batches_count>0
      AND (l.batches_total>l.total OR l.batches_depreciated>l.depreciated
        OR l.total-l.batches_total<l.depreciated-l.batches_depreciated)) AS valid
  FROM raw
)
SELECT CASE WHEN octet_length(proof::text)>2000000 THEN jsonb_set(proof,'{eligible}','false'::jsonb) ELSE proof END
FROM (SELECT jsonb_build_object('schema_version',1,'article_id',article::text,'owner','COMPANY',
  'unit',unit_code,'currency','EUR','quantity',totals.quantity::text,
  'eligible',checks.valid AND totals.quantity>=0 AND totals.quantity<1e26
    AND unit_code=public.fn_stock_opening_scope_1004(unit_code),
  'opening_ids',COALESCE((SELECT jsonb_agg(id::text ORDER BY id) FROM raw WHERE unit=unit_code),'[]'::jsonb),
  'observations',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id::text,'source_sha256',source_sha256,
    'source_snapshot',source_snapshot) ORDER BY id) FROM raw),'[]'::jsonb))
AS proof FROM totals CROSS JOIN checks) bounded
$$;

CREATE FUNCTION public.fn_stock_invoice_candidate_1022(article uuid,unit_code text) RETURNS jsonb
LANGUAGE sql STABLE AS $$
WITH physical AS (SELECT public.fn_stock_invoice_physical_1022(article,unit_code) AS proof),
control AS (SELECT * FROM public.stock_valuation_projector_control WHERE singleton),
balance AS (
  SELECT b.*,e.source_sha256 AS entry_sha256,
    e.source_sha256=encode(digest(e.source_snapshot::text,'sha256'),'hex')
      AND (e.article_id,e.owner_key,e.stock_unit,e.currency) IS NOT DISTINCT FROM (b.article_id,b.owner_key,b.stock_unit,b.currency)
      AND COALESCE(e.source_sequence,0)=b.latest_sequence
      AND (e.source_snapshot->'after_state'->>'quantity')::numeric=b.quantity
      AND (e.source_snapshot->'after_state'->>'value')::numeric IS NOT DISTINCT FROM b.value
      AND e.source_snapshot->'after_state'->>'reliability'=b.reliability
      AND e.source_snapshot->'after_state'->>'sourceRef' IS NOT DISTINCT FROM b.source_ref
      AND (e.movement_id IS NULL OR (e.source_snapshot->>'stock_source_sha256'=j.source_sha256
        AND j.source_sha256=encode(digest(j.source_snapshot::text,'sha256'),'hex'))) AS source_valid
  FROM public.stock_valuation_balances b LEFT JOIN public.stock_valuation_entries e ON e.id=b.latest_entry_id
    LEFT JOIN public.stock_valuation_movement_journal j ON j.movement_id=e.movement_id
  WHERE b.article_id=article AND b.owner_key='COMPANY' AND b.stock_unit=unit_code AND b.currency='EUR'
), checks AS (
  SELECT EXISTS(SELECT 1 FROM public.stock_valuation_movement_journal j WHERE j.sequence>c.last_sequence) AS pending,
    EXISTS(SELECT 1 FROM public.stock_valuation_entries e WHERE e.article_id=article
      AND(e.kind='UNRESOLVED' OR e.source_snapshot->'blocking'='true'::jsonb)) AS blocked,
    EXISTS(SELECT 1 FROM public.stock_movements m CROSS JOIN public.stock_valuation_capture_boundary boundary
      WHERE m.article_id=article AND m.status::text IN('POSTED','COMPENSATED')
        AND(m.posted_at>=boundary.started_at OR m.created_at>=boundary.started_at)
        AND NOT EXISTS(SELECT 1 FROM public.stock_valuation_movement_journal j WHERE j.movement_id=m.id)) AS capture_missing
  FROM control c
)
SELECT jsonb_build_object('schema_version',1,'scope',jsonb_build_object('articleId',article::text,'owner','COMPANY','unit',unit_code,'currency','EUR'),
  'physical',p.proof,'quantity',CASE WHEN p.proof->'eligible'='true'::jsonb THEN p.proof->>'quantity' END,
  'projector',jsonb_build_object('mode',c.mode,'initialized',c.initialized,'formula_version',c.formula_version,
    'reporting_currency',c.reporting_currency,'last_sequence',c.last_sequence::text),
  'checks',to_jsonb(ch),'previous_entry_id',b.latest_entry_id::text,'previous_entry_sha256',b.entry_sha256,
  'before_state',CASE WHEN b.latest_entry_id IS NOT NULL THEN jsonb_build_object('scope',jsonb_build_object(
    'articleId',article::text,'owner','COMPANY','unit',unit_code,'currency','EUR'),'quantity',b.quantity::text,
    'value',b.value::text,'reliability',b.reliability,'sourceRef',b.source_ref) END,
  'eligible',COALESCE(c.mode='ACTIVE' AND c.initialized AND c.reporting_currency='EUR'
    AND c.formula_version='CERP-CUMP-1.0.0' AND NOT ch.pending AND NOT ch.blocked AND NOT ch.capture_missing
    AND p.proof->'eligible'='true'::jsonb AND b.source_valid AND b.latest_sequence<=c.last_sequence
    AND b.quantity=(p.proof->>'quantity')::numeric AND b.quantity>=0 AND b.quantity<1e26
    AND (b.value>=0 AND b.value<1e26 AND b.reliability IN('DECLARED','VERIFIED') AND (b.quantity>0 OR b.value=0))
    AND length(btrim(b.source_ref))>0,false))
FROM physical p CROSS JOIN control c CROSS JOIN checks ch LEFT JOIN balance b ON true
$$;

CREATE FUNCTION public.fn_supplier_invoice_sources_1022(invoice_uuid uuid) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE invoice jsonb; lines jsonb; receipts jsonb:='[]'; lots jsonb:='[]'; trace jsonb:='[]'; balances jsonb:='[]';
 receipt_ids uuid[]; lot_ids uuid[]; scopes jsonb; within_limit boolean;
BEGIN
 SELECT to_jsonb(row) INTO invoice FROM (
SELECT si.id::text,si.row_version,si.fournisseur_id::text AS supplier_id,si.currency,
  si.document_type,match.id::text AS match_id,match.purchase_order_id::text AS order_id,
  (si.status IN('APPROVED','ACCOUNTING_EXPORTED','CLOSED') AND si.approved_at IS NOT NULL
    AND si.approved_by IS NOT NULL AND approval.id IS NOT NULL) AS approved,
  approval.id::text AS approval_id,approval.snapshot->'header_allocation' AS header_allocation,
  CASE WHEN (SELECT count(*) FROM public.supplier_invoice_lines size_lines WHERE size_lines.supplier_invoice_id=si.id)<=2000
    AND (SELECT count(*) FROM public.supplier_invoice_artifacts size_artifacts WHERE size_artifacts.supplier_invoice_id=si.id)<=2000
    THEN jsonb_build_object(
    'invoice_id',si.id::text,'currency',si.currency,'document_type',si.document_type,
    'total_ht',si.total_without_vat::text,'match_version_id',match.id::text,
    'match_purchase_order_id',match.purchase_order_id::text,'match_outcome',match.outcome,
    'supplier_matches',COALESCE(si.fournisseur_id=(SELECT supplier.fournisseur_id
      FROM public.commande_fournisseur supplier WHERE supplier.id=match.purchase_order_id),false),
    'lines',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',all_lines.id::text,
      'position',all_lines.position,'net_ht',all_lines.net_amount::text,
      'purchase_order_line_id',CASE WHEN matched_order.commande_id=match.purchase_order_id
        AND matched_order.statut_ligne<>'ANNULEE' THEN all_matches.purchase_order_line_id::text ELSE NULL END)
        ORDER BY all_lines.position,all_lines.id)
      FROM public.supplier_invoice_lines all_lines
      LEFT JOIN public.supplier_invoice_line_matches all_matches ON all_matches.supplier_invoice_line_id=all_lines.id
        AND all_matches.match_version_id=match.id
      LEFT JOIN public.commande_fournisseur_ligne matched_order ON matched_order.id=all_matches.purchase_order_line_id
      WHERE all_lines.supplier_invoice_id=si.id),'[]'::jsonb),
    'artifacts',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',artifact.id::text,
      'sha256',artifact.content_sha256::text,'document_id',artifact.ged_document_id::text,
      'version_id',artifact.ged_version_id::text,'scan_status',artifact.scan_status,
      'archived_at',to_char(artifact.archived_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
      ORDER BY artifact.id) FROM public.supplier_invoice_artifacts artifact
      WHERE artifact.supplier_invoice_id=si.id),'[]'::jsonb)) END AS header_facts
FROM public.supplier_invoices si
LEFT JOIN LATERAL (SELECT v.* FROM public.supplier_invoice_match_versions v
  WHERE v.supplier_invoice_id=si.id AND v.created_at<=si.approved_at
  ORDER BY v.version DESC LIMIT 1) match ON true
LEFT JOIN LATERAL (SELECT d.id,d.snapshot FROM public.supplier_invoice_decisions d
  WHERE d.supplier_invoice_id=si.id AND d.decision='APPROVED' AND d.to_status='APPROVED'
    AND d.actor_user_id=si.approved_by AND d.created_at<=si.approved_at
  ORDER BY d.created_at DESC,d.id DESC LIMIT 1) approval ON true
WHERE si.id=invoice_uuid) row;
 IF invoice IS NULL THEN RETURN NULL; END IF;
 SELECT COALESCE(jsonb_agg(to_jsonb(rows)),'[]'::jsonb) INTO lines FROM (
SELECT il.id::text,il.position,il.quantity::text,il.unit_code AS unit,
  lm.purchase_order_line_id::text AS order_line_id,lm.reception_line_ids::text[] AS receipt_ids,
  (cl.commande_id=(invoice->>'order_id')::uuid AND cl.statut_ligne<>'ANNULEE') AS link_valid,
  EXISTS(SELECT 1 FROM public.supplier_invoices other
    JOIN LATERAL (SELECT v.id FROM public.supplier_invoice_match_versions v
      WHERE v.supplier_invoice_id=other.id AND v.created_at<=other.approved_at
      ORDER BY v.version DESC LIMIT 1) other_match ON true
    JOIN public.supplier_invoice_line_matches other_line ON other_line.match_version_id=other_match.id
    WHERE other.id<>invoice_uuid AND other.status IN('APPROVED','ACCOUNTING_EXPORTED','CLOSED')
      AND other_line.purchase_order_line_id=lm.purchase_order_line_id
      AND other_line.reception_line_ids && lm.reception_line_ids) AS other_invoice
FROM public.supplier_invoice_lines il
JOIN public.supplier_invoice_line_matches lm ON lm.supplier_invoice_line_id=il.id AND lm.match_version_id=(invoice->>'match_id')::uuid
JOIN public.commande_fournisseur_ligne cl ON cl.id=lm.purchase_order_line_id
WHERE il.supplier_invoice_id=invoice_uuid AND cl.type='MATIERE'
ORDER BY il.position,il.id LIMIT 501) rows;
 SELECT COALESCE(array_agg(DISTINCT value::uuid ORDER BY value::uuid),'{}'::uuid[]) INTO receipt_ids
 FROM jsonb_array_elements(lines) l CROSS JOIN LATERAL jsonb_array_elements_text(l->'receipt_ids') x(value);
 IF cardinality(receipt_ids)<=500 THEN
 SELECT COALESCE(jsonb_agg(to_jsonb(rows)),'[]'::jsonb) INTO receipts FROM (
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
  WHERE s.reception_line_id=ANY(receipt_ids) ORDER BY s.id LIMIT 501
), budget AS (SELECT b.*,sum(bytes) OVER(ORDER BY receipt_stock_id) AS total_bytes FROM bounded b)
SELECT receipt_stock_id,reception_id,receipt_line_id,movement_id,receipt_quantity,receipt_active,
  acquisition_sha256,acquisition_valid,sequence,article_id,source_sha256,source_valid,
  entry_id,owner_key,stock_unit,currency,quantity_delta,movement_value,reliability,entry_sha256,entry_valid,
  total_bytes<=2097152 AS proof_complete,
  CASE WHEN total_bytes<=2097152 THEN acquisition_snapshot END AS acquisition_snapshot,
  CASE WHEN total_bytes<=2097152 THEN source_snapshot END AS source_snapshot,
  CASE WHEN total_bytes<=2097152 THEN entry_snapshot END AS entry_snapshot
FROM budget ORDER BY receipt_stock_id) rows;
 END IF;
 SELECT COALESCE(array_agg(DISTINCT (sl->>'lot_id')::uuid ORDER BY (sl->>'lot_id')::uuid),'{}'::uuid[]) INTO lot_ids
 FROM jsonb_array_elements(receipts) r CROSS JOIN LATERAL jsonb_array_elements(r->'acquisition_snapshot'->'stock_lines') sl
 WHERE sl->>'lot_id' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$';
 SELECT COALESCE(jsonb_agg(jsonb_build_object('article_id',a,'unit',u) ORDER BY a,u),'[]'::jsonb) INTO scopes FROM (
 SELECT DISTINCT r->'acquisition_snapshot'->>'article_id' a,public.fn_stock_opening_scope_1004(r->'acquisition_snapshot'->>'stock_unit') u
 FROM jsonb_array_elements(receipts) r WHERE r->'acquisition_snapshot'->>'article_id' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
 ) s WHERE u IS NOT NULL AND length(u)<=32;
 within_limit:=jsonb_array_length(lines)<=500 AND cardinality(receipt_ids)<=500 AND jsonb_array_length(receipts)<=500
 AND cardinality(lot_ids)<=500 AND jsonb_array_length(scopes)<=500;
 IF within_limit THEN
 SELECT COALESCE(jsonb_agg(to_jsonb(rows)),'[]'::jsonb) INTO lots FROM (
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
FROM public.lots l WHERE l.id=ANY(lot_ids) ORDER BY l.id LIMIT 501) rows;
 SELECT COALESCE(jsonb_agg(to_jsonb(rows)),'[]'::jsonb) INTO trace FROM (
WITH ids AS (SELECT DISTINCT ml.movement_id FROM public.stock_movement_lines ml
  JOIN public.stock_movements m ON m.id=ml.movement_id
  WHERE ml.lot_id=ANY(lot_ids) AND m.status::text IN('POSTED','COMPENSATED')
  ORDER BY ml.movement_id LIMIT 2001), bounded AS (
  SELECT i.movement_id::text,j.article_id::text,j.sequence::text,j.source_sha256,
    j.source_snapshot,COALESCE(j.source_sha256=encode(digest(j.source_snapshot::text,'sha256'),'hex'),false) AS source_valid,
    sum(COALESCE(octet_length(j.source_snapshot::text),0)) OVER(ORDER BY i.movement_id) AS total_bytes
  FROM ids i LEFT JOIN public.stock_valuation_movement_journal j ON j.movement_id=i.movement_id
)
SELECT movement_id,article_id,sequence,source_sha256,source_valid,total_bytes<=2097152 AS proof_complete,
  CASE WHEN total_bytes<=2097152 THEN source_snapshot END AS source_snapshot
FROM bounded ORDER BY movement_id) rows;
 SELECT COALESCE(jsonb_agg(to_jsonb(rows)),'[]'::jsonb) INTO balances FROM (
SELECT s.article_id,s.unit,public.fn_stock_invoice_candidate_1022(s.article_id,s.unit) AS source_snapshot
FROM jsonb_to_recordset(scopes) AS s(article_id uuid,unit text)
ORDER BY s.article_id,s.unit) rows;
 END IF;
 RETURN jsonb_build_object('invoice',invoice,'lines',lines,'receipts',receipts,'lots',lots,'trace',trace,'balances',balances,
 'complete',within_limit AND jsonb_array_length(trace)<=2000 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(receipts) r
 WHERE r->'proof_complete' IS DISTINCT FROM 'true'::jsonb) AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(trace) t
 WHERE t->'proof_complete' IS DISTINCT FROM 'true'::jsonb));
END $$;

CREATE TABLE public.stock_valuation_invoice_reconciliations (
 id uuid PRIMARY KEY, invoice_id uuid NOT NULL UNIQUE REFERENCES public.supplier_invoices(id) ON DELETE RESTRICT,
 request_id uuid NOT NULL UNIQUE, request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 proposal_source_sha256 text NOT NULL CHECK(proposal_source_sha256 ~ '^[a-f0-9]{64}$'),
 source_snapshot jsonb NOT NULL CHECK(jsonb_typeof(source_snapshot)='object' AND octet_length(source_snapshot::text)<=8388608),
 source_sha256 text NOT NULL CHECK(source_sha256 ~ '^[a-f0-9]{64}$'),
 created_by integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE public.stock_valuation_invoice_scope_adjustments (
 entry_id uuid PRIMARY KEY REFERENCES public.stock_valuation_entries(id) DEFERRABLE INITIALLY DEFERRED,
 reconciliation_id uuid NOT NULL REFERENCES public.stock_valuation_invoice_reconciliations(id) ON DELETE RESTRICT,
 article_id uuid NOT NULL REFERENCES public.articles(id) ON DELETE RESTRICT, stock_unit text NOT NULL CHECK(length(stock_unit) BETWEEN 1 AND 32),
 previous_entry_id uuid NOT NULL REFERENCES public.stock_valuation_entries(id) ON DELETE RESTRICT,
 quantity numeric(38,12) NOT NULL CHECK(quantity>=0), previous_value_ht numeric(38,12) NOT NULL CHECK(previous_value_ht>=0),
 stock_variance_ht numeric(38,12) NOT NULL, consumed_variance_ht numeric(38,12) NOT NULL,
 total_value_ht numeric(38,12) NOT NULL CHECK(total_value_ht>=0),
 CHECK(total_value_ht=previous_value_ht+stock_variance_ht AND (quantity>0 OR total_value_ht=0)),
 UNIQUE(reconciliation_id,article_id,stock_unit)
);
CREATE TABLE public.stock_valuation_invoice_consumption_adjustments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 reconciliation_id uuid NOT NULL REFERENCES public.stock_valuation_invoice_reconciliations(id) ON DELETE RESTRICT,
 invoice_line_id uuid NOT NULL REFERENCES public.supplier_invoice_lines(id) ON DELETE RESTRICT,
 lot_id uuid NOT NULL REFERENCES public.lots(id) ON DELETE RESTRICT,
 movement_id uuid NOT NULL REFERENCES public.stock_valuation_movement_journal(movement_id) ON DELETE RESTRICT,
 line_id uuid NOT NULL REFERENCES public.stock_movement_lines(id) ON DELETE RESTRICT,
 of_id bigint REFERENCES public.ordres_fabrication(id) ON DELETE RESTRICT,
 quantity numeric(38,12) NOT NULL CHECK(quantity>0), amount_ht numeric(38,12) NOT NULL,
 stock_sha256 text NOT NULL CHECK(stock_sha256 ~ '^[a-f0-9]{64}$'),
 UNIQUE(reconciliation_id,line_id)
);
CREATE INDEX stock_invoice_consumption_of_1022 ON public.stock_valuation_invoice_consumption_adjustments(of_id,line_id);
ALTER TABLE public.stock_valuation_entries ADD COLUMN invoice_reconciliation_id uuid
 REFERENCES public.stock_valuation_invoice_reconciliations(id) ON DELETE RESTRICT;
ALTER TABLE public.stock_valuation_entries DROP CONSTRAINT stock_value_entry_kind_1007,
 DROP CONSTRAINT stock_value_entry_shape_1007, DROP CONSTRAINT stock_value_posting_unique_1007;
ALTER TABLE public.stock_valuation_entries ADD CONSTRAINT stock_invoice_entry_kind_1022 CHECK(
 kind IN('OPENING','RECEIPT','ISSUE','SCRAP','RETURN','RECEIPT_REVERSAL','TRANSFER','ZERO','UNRESOLVED','VALUE_ADJUSTMENT','INVOICE_ADJUSTMENT'));
ALTER TABLE public.stock_valuation_entries ADD CONSTRAINT stock_invoice_entry_shape_1022 CHECK(
 (kind='OPENING' AND movement_id IS NULL AND source_sequence IS NULL)
 OR(kind='UNRESOLVED' AND owner_key IS NULL AND stock_unit IS NULL AND quantity_delta IS NULL
 AND value_delta IS NULL AND movement_value IS NULL AND reliability='UNKNOWN')
 OR(kind='ZERO' AND movement_id IS NOT NULL AND source_sequence IS NOT NULL AND quantity_delta=0 AND value_delta=0 AND movement_value IS NULL)
 OR(kind='VALUE_ADJUSTMENT' AND movement_id IS NULL AND source_sequence IS NOT NULL AND source_sequence>=0 AND owner_key='COMPANY' AND currency='EUR'
 AND stock_unit IS NOT NULL AND quantity_delta=0 AND reliability='DECLARED' AND value_adjustment_id IS NOT NULL)
 OR(kind='INVOICE_ADJUSTMENT' AND movement_id IS NULL AND source_sequence IS NOT NULL AND source_sequence>=0 AND owner_key='COMPANY' AND currency='EUR'
 AND stock_unit IS NOT NULL AND quantity_delta=0 AND reliability='DECLARED' AND invoice_reconciliation_id IS NOT NULL)
 OR(kind NOT IN('OPENING','UNRESOLVED','ZERO','VALUE_ADJUSTMENT','INVOICE_ADJUSTMENT') AND movement_id IS NOT NULL AND source_sequence IS NOT NULL
 AND owner_key IS NOT NULL AND stock_unit IS NOT NULL AND quantity_delta IS NOT NULL));
ALTER TABLE public.stock_valuation_entries ADD CONSTRAINT stock_invoice_entry_identity_1022
 CHECK((kind='INVOICE_ADJUSTMENT')=(invoice_reconciliation_id IS NOT NULL));
ALTER TABLE public.stock_valuation_entries ADD CONSTRAINT stock_invoice_posting_unique_1022
 UNIQUE NULLS NOT DISTINCT(movement_id,article_id,owner_key,stock_unit,currency,value_adjustment_id,invoice_reconciliation_id);

-- Independent decimal arithmetic checks accompany the service's complete
-- physical-lineage checks. No HTTP-supplied monetary value is accepted.
CREATE FUNCTION public.fn_stock_invoice_math_1022(src jsonb, proposal jsonb, posting jsonb) RETURNS boolean LANGUAGE plpgsql AS $$
#variable_conflict use_column
DECLARE il jsonb; pl jsonb; lp jsonb; receipt jsonb; fiscal jsonb; ref jsonb; physical_line jsonb; trace_row jsonb;
 target numeric; net numeric; weight_total numeric; prefix numeric; difference numeric; allocated numeric; received numeric; purchase numeric;
 booked numeric; remaining numeric; consumed numeric; delta numeric; stock_delta numeric; prior_purchase numeric; invoiced numeric;
 ref_qty numeric; ref_amount numeric; ref_prefix numeric; line_booked numeric; line_stock numeric; line_consumed numeric;
 lot_count integer; expected_of text; adjustment jsonb; candidate jsonb; sum_stock numeric; sum_consumed numeric;
BEGIN
 IF src->'complete' IS DISTINCT FROM 'true'::jsonb OR proposal->'calculable' IS DISTINCT FROM 'true'::jsonb
 OR proposal->'projection_ready' IS DISTINCT FROM 'true'::jsonb OR src->'invoice'->'approved' IS DISTINCT FROM 'true'::jsonb
 OR src->'invoice'->>'document_type' IS DISTINCT FROM 'INVOICE' OR src->'invoice'->>'currency' IS DISTINCT FROM 'EUR'
 OR proposal->>'method' IS DISTINCT FROM 'INVOICE_LOT_REMAINING_V1'
 OR posting->>'formula' IS DISTINCT FROM 'CERP-CUMP-INVOICE-1.0.0'
 OR jsonb_array_length(src->'lines') NOT BETWEEN 1 AND 500
 OR jsonb_array_length(proposal->'lines')<>jsonb_array_length(src->'lines')
 OR jsonb_array_length(posting->'adjustments')<>jsonb_array_length(src->'balances')
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(src->'receipts') r WHERE r->'acquisition_valid' IS DISTINCT FROM 'true'::jsonb
 OR r->'source_valid' IS DISTINCT FROM 'true'::jsonb OR r->'entry_valid' IS DISTINCT FROM 'true'::jsonb OR r->'receipt_active' IS DISTINCT FROM 'true'::jsonb)
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(src->'trace') t WHERE t->'source_valid' IS DISTINCT FROM 'true'::jsonb)
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(src->'lots') l WHERE l->'has_opening' IS DISTINCT FROM 'false'::jsonb
 OR l->>'owner_client_id' IS NOT NULL) THEN RETURN false; END IF;
 fiscal:=src->'invoice'->'header_facts';
 IF fiscal->>'match_outcome' IS DISTINCT FROM 'MATCHED' OR fiscal->'supplier_matches' IS DISTINCT FROM 'true'::jsonb
 OR fiscal->>'invoice_id' IS DISTINCT FROM src->'invoice'->>'id'
 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(fiscal->'artifacts'))
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(fiscal->'artifacts') a WHERE a->>'scan_status' IS DISTINCT FROM 'CLEAN'
 OR a->>'document_id' IS NULL OR a->>'version_id' IS NULL OR a->>'archived_at' IS NULL) THEN RETURN false; END IF;
 SELECT sum((l->>'net_ht')::numeric) INTO weight_total FROM jsonb_array_elements(fiscal->'lines') l;
 difference:=(fiscal->>'total_ht')::numeric-weight_total;
 IF weight_total<0 OR (fiscal->>'total_ht')::numeric<0 OR weight_total=0 AND difference<>0 THEN RETURN false; END IF;
 FOR il IN SELECT value FROM jsonb_array_elements(src->'lines') LOOP
 SELECT value INTO pl FROM jsonb_array_elements(proposal->'lines') WHERE value->>'invoice_line_id'=il->>'id';
 IF pl IS NULL OR pl->'calculable' IS DISTINCT FROM 'true'::jsonb OR pl->'projection_ready' IS DISTINCT FROM 'true'::jsonb
 OR il->'link_valid' IS DISTINCT FROM 'true'::jsonb OR il->'other_invoice' IS DISTINCT FROM 'false'::jsonb
 OR (SELECT count(*) FROM jsonb_array_elements(proposal->'lines') WHERE value->>'invoice_line_id'=il->>'id')<>1 THEN RETURN false; END IF;
 SELECT (l->>'net_ht')::numeric INTO net FROM jsonb_array_elements(fiscal->'lines') l WHERE l->>'id'=il->>'id';
 SELECT COALESCE(sum((l->>'net_ht')::numeric),0) INTO prefix FROM jsonb_array_elements(fiscal->'lines') l
 WHERE ((l->>'position')::integer,l->>'id')<((il->>'position')::integer,il->>'id');
 target:=net+CASE WHEN difference=0 THEN 0 ELSE sign(difference)*(round(abs(difference)*(prefix+net)/weight_total,2)
 -round(abs(difference)*prefix/weight_total,2)) END;
 IF target<0 OR target IS NULL OR (pl->>'invoice_amount_ht')::numeric IS DISTINCT FROM target THEN RETURN false; END IF;
 IF difference<>0 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(src->'invoice'->'header_allocation'->'lines') l
 WHERE l->>'id'=il->>'id' AND (l->>'total_ht')::numeric=target) THEN RETURN false; END IF;
 invoiced:=(il->>'quantity')::numeric; prior_purchase:=0;line_booked:=0;line_stock:=0;line_consumed:=0;
 IF invoiced<=0 OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(il->'receipt_ids') rid WHERE NOT EXISTS(
 SELECT 1 FROM jsonb_array_elements(src->'receipts') r WHERE r->>'receipt_line_id'=rid.value)) THEN RETURN false; END IF;
 SELECT count(DISTINCT sl->>'lot_id') INTO lot_count FROM jsonb_array_elements(src->'receipts') r
 CROSS JOIN LATERAL jsonb_array_elements(r->'acquisition_snapshot'->'stock_lines') sl
 WHERE il->'receipt_ids' ? (r->>'receipt_line_id');
 IF jsonb_array_length(pl->'lots')<>lot_count OR lot_count=0
 OR (SELECT count(DISTINCT l->>'lot_id') FROM jsonb_array_elements(pl->'lots') l)<>lot_count THEN RETURN false; END IF;
 FOR lp IN SELECT value FROM jsonb_array_elements(pl->'lots') ORDER BY value->>'lot_id' LOOP
 received:=0;purchase:=0;booked:=0;
 FOR receipt IN SELECT r FROM jsonb_array_elements(src->'receipts') r WHERE il->'receipt_ids' ? (r->>'receipt_line_id')
 AND EXISTS(SELECT 1 FROM jsonb_array_elements(r->'acquisition_snapshot'->'stock_lines') sl WHERE sl->>'lot_id'=lp->>'lot_id') LOOP
 IF receipt->>'article_id' IS DISTINCT FROM lp->>'article_id' OR receipt->>'stock_unit' IS DISTINCT FROM lp->>'unit'
 OR receipt->>'owner_key' IS DISTINCT FROM 'COMPANY' OR receipt->>'currency' IS DISTINCT FROM 'EUR'
 OR (SELECT count(DISTINCT sl->>'lot_id') FROM jsonb_array_elements(receipt->'acquisition_snapshot'->'stock_lines') sl)<>1 THEN RETURN false; END IF;
 purchase:=purchase+(receipt->>'receipt_quantity')::numeric;
 received:=received+(receipt->>'quantity_delta')::numeric; booked:=booked+(receipt->>'movement_value')::numeric;
 END LOOP;
 SELECT sum((b->>'quantity_total')::numeric-(b->>'quantity_depreciated')::numeric) INTO remaining
 FROM jsonb_array_elements(src->'lots') l CROSS JOIN LATERAL jsonb_array_elements(l->'batches') b WHERE l->>'lot_id'=lp->>'lot_id';
 remaining:=COALESCE(remaining,0);consumed:=received-remaining;
 IF received<=0 OR purchase<=0 OR remaining<0 OR consumed<0 THEN RETURN false; END IF;
 allocated:=round(target*(prior_purchase+purchase)/invoiced,12)-round(target*prior_purchase/invoiced,12);
 prior_purchase:=prior_purchase+purchase;delta:=allocated-booked;stock_delta:=round(delta*remaining/received,12);
 IF (lp->>'received_quantity')::numeric IS DISTINCT FROM received OR (lp->>'remaining_quantity')::numeric IS DISTINCT FROM remaining
 OR (lp->>'consumed_quantity')::numeric IS DISTINCT FROM consumed OR (lp->>'invoice_amount_ht')::numeric IS DISTINCT FROM allocated
 OR (lp->>'booked_amount_ht')::numeric IS DISTINCT FROM booked OR (lp->>'variance_ht')::numeric IS DISTINCT FROM delta
 OR (lp->>'stock_variance_ht')::numeric IS DISTINCT FROM stock_delta
 OR (lp->>'consumed_variance_ht')::numeric IS DISTINCT FROM delta-stock_delta THEN RETURN false; END IF;
 ref_prefix:=0;
 FOR ref IN SELECT value FROM jsonb_array_elements(posting->'consumption') WHERE value->>'invoice_line_id'=il->>'id'
 AND value->>'lot_id'=lp->>'lot_id' ORDER BY value->>'movement_id',value->>'line_id' LOOP
 SELECT t INTO trace_row FROM jsonb_array_elements(src->'trace') t WHERE t->>'movement_id'=ref->>'movement_id';
 SELECT l INTO physical_line FROM jsonb_array_elements(trace_row->'source_snapshot'->'lines') l WHERE l->>'line_id'=ref->>'line_id';
 ref_qty:=(physical_line->>'quantity')::numeric;
 expected_of:=CASE WHEN trace_row->'source_snapshot'->>'source_document_type'='OF'
 AND trace_row->'source_snapshot'->>'source_document_id' ~ '^[1-9][0-9]{0,18}$' THEN trace_row->'source_snapshot'->>'source_document_id' END;
 IF trace_row IS NULL OR physical_line IS NULL OR ref_qty<=0 OR ref_qty IS NULL OR consumed=0
 OR (trace_row->'source_snapshot'->>'movement_type' IN('OUT','SCRAP','DEPRECIATE')) IS DISTINCT FROM true
 OR trace_row->'source_snapshot'->>'document_type' IS NOT DISTINCT FROM 'STOCK_TRANSFER_INTERNAL'
 OR physical_line->>'lot_id' IS DISTINCT FROM lp->>'lot_id' OR physical_line->>'owner_client_id' IS NOT NULL
 OR physical_line->>'article_id' IS DISTINCT FROM lp->>'article_id'
 OR public.fn_stock_opening_scope_1004(physical_line->>'unit') IS DISTINCT FROM lp->>'unit'
 OR ref->>'stock_sha256' IS DISTINCT FROM trace_row->>'source_sha256' OR ref->>'of_id' IS DISTINCT FROM expected_of
 OR (ref->>'quantity')::numeric IS DISTINCT FROM ref_qty THEN RETURN false; END IF;
 ref_amount:=round((delta-stock_delta)*(ref_prefix+ref_qty)/consumed,12)-round((delta-stock_delta)*ref_prefix/consumed,12);
 IF (ref->>'amount_ht')::numeric IS DISTINCT FROM ref_amount THEN RETURN false; END IF;
 ref_prefix:=ref_prefix+ref_qty;
 END LOOP;
 IF ref_prefix<>consumed THEN RETURN false; END IF;
 line_booked:=line_booked+booked;line_stock:=line_stock+stock_delta;line_consumed:=line_consumed+delta-stock_delta;
 END LOOP;
 IF prior_purchase<>invoiced OR (pl->>'booked_amount_ht')::numeric IS DISTINCT FROM line_booked
 OR (pl->>'variance_ht')::numeric IS DISTINCT FROM target-line_booked OR (pl->>'stock_variance_ht')::numeric IS DISTINCT FROM line_stock
 OR (pl->>'consumed_variance_ht')::numeric IS DISTINCT FROM line_consumed THEN RETURN false; END IF;
 END LOOP;
 IF (SELECT count(*) FROM jsonb_array_elements(posting->'consumption'))<>(SELECT count(DISTINCT r->>'line_id') FROM jsonb_array_elements(posting->'consumption') r)
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(posting->'consumption') r WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(proposal->'lines') pl
 CROSS JOIN LATERAL jsonb_array_elements(pl->'lots') lp WHERE pl->>'invoice_line_id'=r->>'invoice_line_id' AND lp->>'lot_id'=r->>'lot_id'))
 OR (SELECT count(*) FROM jsonb_array_elements(posting->'adjustments'))<>(SELECT count(DISTINCT (r->>'article_id',r->>'unit')) FROM jsonb_array_elements(posting->'adjustments') r) THEN RETURN false; END IF;
 FOR adjustment IN SELECT value FROM jsonb_array_elements(posting->'adjustments') LOOP
 SELECT b->'source_snapshot' INTO candidate FROM jsonb_array_elements(src->'balances') b
 WHERE b->>'article_id'=adjustment->>'article_id' AND b->>'unit'=adjustment->>'unit';
 SELECT sum((lp->>'stock_variance_ht')::numeric),sum((lp->>'consumed_variance_ht')::numeric) INTO sum_stock,sum_consumed
 FROM jsonb_array_elements(proposal->'lines') pl CROSS JOIN LATERAL jsonb_array_elements(pl->'lots') lp
 WHERE lp->>'article_id'=adjustment->>'article_id' AND lp->>'unit'=adjustment->>'unit';
 IF candidate->'eligible' IS DISTINCT FROM 'true'::jsonb OR adjustment->'result'->'before' IS DISTINCT FROM candidate->'before_state'
 OR (adjustment->>'stock_variance_ht')::numeric IS DISTINCT FROM sum_stock
 OR (adjustment->>'consumed_variance_ht')::numeric IS DISTINCT FROM sum_consumed
 OR (adjustment->'result'->>'valueDelta')::numeric IS DISTINCT FROM sum_stock
 OR (adjustment->'result'->>'quantityDelta')::numeric IS DISTINCT FROM 0
 OR (adjustment->'result'->>'movementValue')::numeric IS DISTINCT FROM abs(sum_stock)
 OR (adjustment->'result'->'after'->>'quantity')::numeric IS DISTINCT FROM (candidate->>'quantity')::numeric
 OR (adjustment->'result'->'after'->>'value')::numeric IS DISTINCT FROM (candidate->'before_state'->>'value')::numeric+sum_stock
 OR adjustment->'result'->'after'->>'reliability' IS DISTINCT FROM 'DECLARED'
 OR adjustment->'result'->'after'->>'sourceRef' IS DISTINCT FROM 'stock-valuation-entry:'||(adjustment->>'entry_id')
 OR adjustment->'result'->'after'->'scope' IS DISTINCT FROM candidate->'scope'
 OR adjustment->'result'->>'formulaVersion' IS DISTINCT FROM 'CERP-CUMP-1.0.0'
 OR adjustment->'result'->>'movementReliability' IS DISTINCT FROM 'DECLARED'
 OR adjustment->'result'->'unitCost' IS DISTINCT FROM 'null'::jsonb OR adjustment->'result'->'issues' IS DISTINCT FROM '[]'::jsonb THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
END $$;

CREATE FUNCTION public.fn_stock_invoice_parent_guard_1022() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE src jsonb;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Invoice corrections are immutable' USING ERRCODE='23514'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('stock:cump-projector:1',0));
 PERFORM 1 FROM public.stock_valuation_projector_control WHERE singleton FOR UPDATE;
 LOCK TABLE public.stock_valuation_movement_journal IN SHARE MODE;
 PERFORM 1 FROM public.supplier_invoices WHERE id=NEW.invoice_id FOR SHARE;
 LOCK TABLE public.supplier_invoice_artifacts,public.supplier_invoice_lines,public.supplier_invoice_line_matches,
 public.supplier_invoice_match_versions,public.supplier_invoice_decisions IN SHARE MODE;
 src:=public.fn_supplier_invoice_sources_1022(NEW.invoice_id);
 IF NEW.source_sha256<>encode(digest(NEW.source_snapshot::text,'sha256'),'hex') OR src IS NULL
 OR NEW.source_snapshot->'source' IS DISTINCT FROM src OR NEW.source_snapshot->>'schema_version' IS DISTINCT FROM '1'
 OR NEW.source_snapshot->'proposal'->>'source_sha256' IS DISTINCT FROM NEW.proposal_source_sha256
 OR NEW.source_snapshot->'proposal'->>'id' IS DISTINCT FROM NEW.invoice_id::text
 OR NEW.source_snapshot->'approval'->>'created_by' IS DISTINCT FROM NEW.created_by::text
 OR NEW.source_snapshot->'response'->>'id' IS DISTINCT FROM NEW.id::text
 OR NEW.source_snapshot->'response'->>'invoice_id' IS DISTINCT FROM NEW.invoice_id::text
 OR NEW.source_snapshot->'response'->'posting' IS DISTINCT FROM NEW.source_snapshot->'posting'
 OR NEW.source_snapshot->'response'->>'source_sha256' IS DISTINCT FROM NEW.proposal_source_sha256
 OR NOT public.fn_stock_invoice_math_1022(src,NEW.source_snapshot->'proposal',NEW.source_snapshot->'posting') THEN
 RAISE EXCEPTION 'Invoice correction requires exact current approved sources and decimal attribution' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER stock_invoice_parent_immutable BEFORE INSERT OR UPDATE OR DELETE ON public.stock_valuation_invoice_reconciliations
 FOR EACH ROW EXECUTE FUNCTION public.fn_stock_invoice_parent_guard_1022();
CREATE TRIGGER stock_invoice_parent_truncate BEFORE TRUNCATE ON public.stock_valuation_invoice_reconciliations
 FOR EACH STATEMENT EXECUTE FUNCTION public.fn_stock_invoice_parent_guard_1022();

CREATE FUNCTION public.fn_stock_invoice_child_guard_1022() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p public.stock_valuation_invoice_reconciliations%ROWTYPE; item jsonb; candidate jsonb;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Invoice correction evidence is immutable' USING ERRCODE='23514'; END IF;
 SELECT * INTO p FROM public.stock_valuation_invoice_reconciliations WHERE id=NEW.reconciliation_id;
 IF NOT FOUND OR p.source_sha256<>encode(digest(p.source_snapshot::text,'sha256'),'hex') THEN
 RAISE EXCEPTION 'Invoice correction proof missing' USING ERRCODE='23514'; END IF;
 IF TG_TABLE_NAME='stock_valuation_invoice_scope_adjustments' THEN
 SELECT a INTO item FROM jsonb_array_elements(p.source_snapshot->'posting'->'adjustments') a WHERE a->>'entry_id'=NEW.entry_id::text;
 SELECT b->'source_snapshot' INTO candidate FROM jsonb_array_elements(p.source_snapshot->'source'->'balances') b
 WHERE b->>'article_id'=NEW.article_id::text AND b->>'unit'=NEW.stock_unit;
 IF item IS NULL OR item->>'article_id' IS DISTINCT FROM NEW.article_id::text OR item->>'unit' IS DISTINCT FROM NEW.stock_unit
 OR candidate->>'previous_entry_id' IS DISTINCT FROM NEW.previous_entry_id::text
 OR (item->'result'->'before'->>'quantity')::numeric IS DISTINCT FROM NEW.quantity
 OR (item->'result'->'before'->>'value')::numeric IS DISTINCT FROM NEW.previous_value_ht
 OR (item->'result'->'after'->>'value')::numeric IS DISTINCT FROM NEW.total_value_ht
 OR (item->>'stock_variance_ht')::numeric IS DISTINCT FROM NEW.stock_variance_ht
 OR (item->>'consumed_variance_ht')::numeric IS DISTINCT FROM NEW.consumed_variance_ht THEN
 RAISE EXCEPTION 'Invoice scope differs from approved posting' USING ERRCODE='23514'; END IF;
 ELSE
 SELECT a INTO item FROM jsonb_array_elements(p.source_snapshot->'posting'->'consumption') a WHERE a->>'line_id'=NEW.line_id::text;
 IF item IS NULL OR item->>'invoice_line_id' IS DISTINCT FROM NEW.invoice_line_id::text OR item->>'lot_id' IS DISTINCT FROM NEW.lot_id::text
 OR item->>'movement_id' IS DISTINCT FROM NEW.movement_id::text OR item->>'of_id' IS DISTINCT FROM NEW.of_id::text
 OR (item->>'quantity')::numeric IS DISTINCT FROM NEW.quantity OR (item->>'amount_ht')::numeric IS DISTINCT FROM NEW.amount_ht
 OR item->>'stock_sha256' IS DISTINCT FROM NEW.stock_sha256 THEN
 RAISE EXCEPTION 'Invoice consumption differs from immutable physical attribution' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER stock_invoice_scope_immutable BEFORE INSERT OR UPDATE OR DELETE ON public.stock_valuation_invoice_scope_adjustments
 FOR EACH ROW EXECUTE FUNCTION public.fn_stock_invoice_child_guard_1022();
CREATE TRIGGER stock_invoice_scope_truncate BEFORE TRUNCATE ON public.stock_valuation_invoice_scope_adjustments
 FOR EACH STATEMENT EXECUTE FUNCTION public.fn_stock_invoice_child_guard_1022();
CREATE TRIGGER stock_invoice_consumption_immutable BEFORE INSERT OR UPDATE OR DELETE ON public.stock_valuation_invoice_consumption_adjustments
 FOR EACH ROW EXECUTE FUNCTION public.fn_stock_invoice_child_guard_1022();
CREATE TRIGGER stock_invoice_consumption_truncate BEFORE TRUNCATE ON public.stock_valuation_invoice_consumption_adjustments
 FOR EACH STATEMENT EXECUTE FUNCTION public.fn_stock_invoice_child_guard_1022();

CREATE FUNCTION public.fn_stock_invoice_entry_guard_1022() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a public.stock_valuation_invoice_scope_adjustments%ROWTYPE; p public.stock_valuation_invoice_reconciliations%ROWTYPE;
 item jsonb; candidate jsonb;
BEGIN
 IF NEW.kind<>'INVOICE_ADJUSTMENT' THEN RETURN NEW; END IF;
 SELECT * INTO a FROM public.stock_valuation_invoice_scope_adjustments WHERE entry_id=NEW.id;
 SELECT * INTO p FROM public.stock_valuation_invoice_reconciliations WHERE id=NEW.invoice_reconciliation_id;
 SELECT v INTO item FROM jsonb_array_elements(p.source_snapshot->'posting'->'adjustments') v WHERE v->>'entry_id'=NEW.id::text;
 SELECT b->'source_snapshot' INTO candidate FROM jsonb_array_elements(p.source_snapshot->'source'->'balances') b
 WHERE b->>'article_id'=NEW.article_id::text AND b->>'unit'=NEW.stock_unit;
 IF a.entry_id IS NULL OR p.id IS NULL OR a.reconciliation_id<>p.id OR a.article_id<>NEW.article_id OR a.stock_unit<>NEW.stock_unit
 OR p.source_sha256<>encode(digest(p.source_snapshot::text,'sha256'),'hex') OR NEW.value_delta IS DISTINCT FROM a.stock_variance_ht
 OR NEW.movement_value IS DISTINCT FROM abs(a.stock_variance_ht) OR NEW.source_snapshot->>'invoice_reconciliation_id' IS DISTINCT FROM p.id::text
 OR NEW.source_snapshot->>'invoice_reconciliation_sha256' IS DISTINCT FROM p.source_sha256
 OR NEW.source_snapshot->>'previous_entry_id' IS DISTINCT FROM a.previous_entry_id::text
 OR NEW.source_snapshot->'result' IS DISTINCT FROM item->'result' OR NEW.issues IS DISTINCT FROM '[]'::jsonb
 OR NEW.source_sequence IS DISTINCT FROM (candidate->'projector'->>'last_sequence')::bigint
 OR candidate IS DISTINCT FROM public.fn_stock_invoice_candidate_1022(NEW.article_id,NEW.stock_unit) THEN
 RAISE EXCEPTION 'Invoice entry requires its exact prior balance and approved scope' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER stock_invoice_entry_guard BEFORE INSERT ON public.stock_valuation_entries
 FOR EACH ROW EXECUTE FUNCTION public.fn_stock_invoice_entry_guard_1022();

CREATE FUNCTION public.fn_stock_invoice_commit_guard_1022() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (SELECT count(*) FROM public.stock_valuation_invoice_scope_adjustments WHERE reconciliation_id=NEW.id)
 <>jsonb_array_length(NEW.source_snapshot->'posting'->'adjustments')
 OR (SELECT count(*) FROM public.stock_valuation_invoice_consumption_adjustments WHERE reconciliation_id=NEW.id)
 <>jsonb_array_length(NEW.source_snapshot->'posting'->'consumption')
 OR EXISTS(SELECT 1 FROM public.stock_valuation_invoice_scope_adjustments a
 LEFT JOIN public.stock_valuation_entries e ON e.id=a.entry_id LEFT JOIN public.stock_valuation_balances b ON b.latest_entry_id=e.id
 WHERE a.reconciliation_id=NEW.id AND (e.id IS NULL OR b.latest_entry_id IS NULL OR e.kind<>'INVOICE_ADJUSTMENT'
 OR e.invoice_reconciliation_id IS DISTINCT FROM NEW.id OR e.article_id<>a.article_id OR e.stock_unit<>a.stock_unit
 OR e.owner_key<>'COMPANY' OR e.currency<>'EUR' OR e.source_snapshot->>'invoice_reconciliation_sha256' IS DISTINCT FROM NEW.source_sha256
 OR b.quantity IS DISTINCT FROM a.quantity OR b.value IS DISTINCT FROM a.total_value_ht OR b.reliability<>'DECLARED'
 OR b.source_ref IS DISTINCT FROM 'stock-valuation-entry:'||a.entry_id::text OR b.latest_sequence IS DISTINCT FROM e.source_sequence)) THEN
 RAISE EXCEPTION 'Invoice correction must commit every exact entry, balance and consumed allocation atomically' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER stock_invoice_commit_guard AFTER INSERT ON public.stock_valuation_invoice_reconciliations
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.fn_stock_invoice_commit_guard_1022();

ALTER TABLE public.stock_valuation_invoice_reconciliations OWNER TO cerp_app;
ALTER TABLE public.stock_valuation_invoice_scope_adjustments OWNER TO cerp_app;
ALTER TABLE public.stock_valuation_invoice_consumption_adjustments OWNER TO cerp_app;
ALTER FUNCTION public.fn_stock_invoice_physical_1022(uuid,text) OWNER TO cerp_app;
ALTER FUNCTION public.fn_stock_invoice_candidate_1022(uuid,text) OWNER TO cerp_app;
ALTER FUNCTION public.fn_supplier_invoice_sources_1022(uuid) OWNER TO cerp_app;
ALTER FUNCTION public.fn_stock_invoice_math_1022(jsonb,jsonb,jsonb) OWNER TO cerp_app;
ALTER FUNCTION public.fn_stock_invoice_parent_guard_1022() OWNER TO cerp_app;
ALTER FUNCTION public.fn_stock_invoice_child_guard_1022() OWNER TO cerp_app;
ALTER FUNCTION public.fn_stock_invoice_entry_guard_1022() OWNER TO cerp_app;
ALTER FUNCTION public.fn_stock_invoice_commit_guard_1022() OWNER TO cerp_app;
COMMENT ON TABLE public.stock_valuation_invoice_reconciliations IS 'Explicit immutable sourced invoice variance; no activation or historical journal overwrite.';
COMMIT;
