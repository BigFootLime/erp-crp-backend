-- Documented current company value, quantity unchanged; PREPARED is not activated.
BEGIN;
SET LOCAL lock_timeout='10s';

CREATE FUNCTION public.fn_stock_value_physical_1007(article uuid, unit_code text) RETURNS jsonb
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
SELECT CASE WHEN pg_column_size(proof)>2000000 THEN jsonb_set(proof,'{eligible}','false'::jsonb) ELSE proof END
FROM (SELECT jsonb_build_object('schema_version',1,'article_id',article::text,'owner','COMPANY',
  'unit',unit_code,'currency','EUR','quantity',totals.quantity::text,
  'eligible',checks.valid AND totals.quantity>0 AND totals.quantity<1e26
    AND unit_code=public.fn_stock_opening_scope_1004(unit_code),
  'opening_ids',COALESCE((SELECT jsonb_agg(id::text ORDER BY id) FROM raw WHERE unit=unit_code),'[]'::jsonb),
  'observations',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id::text,'source_sha256',source_sha256,
    'source_snapshot',source_snapshot) ORDER BY id) FROM raw),'[]'::jsonb))
AS proof FROM totals CROSS JOIN checks) bounded
$$;

CREATE FUNCTION public.fn_stock_value_candidate_1007(article uuid,unit_code text) RETURNS jsonb
LANGUAGE sql STABLE AS $$
WITH physical AS (SELECT public.fn_stock_value_physical_1007(article,unit_code) AS proof),
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
    AND b.quantity=(p.proof->>'quantity')::numeric AND b.quantity>0 AND b.quantity<1e26
    AND (b.value IS NULL AND b.reliability='UNKNOWN' OR b.value>=0 AND b.value<1e26 AND b.reliability IN('DECLARED','VERIFIED'))
    AND length(btrim(b.source_ref))>0,false))
FROM physical p CROSS JOIN control c CROSS JOIN checks ch LEFT JOIN balance b ON true
$$;

CREATE TABLE public.stock_valuation_value_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id uuid NOT NULL UNIQUE REFERENCES public.stock_valuation_entries(id) DEFERRABLE INITIALLY DEFERRED,
  article_id uuid NOT NULL REFERENCES public.articles(id) ON DELETE RESTRICT,
  owner_key text NOT NULL DEFAULT 'COMPANY' CHECK(owner_key='COMPANY'),
  stock_unit text NOT NULL CHECK(length(stock_unit) BETWEEN 1 AND 32),
  currency text NOT NULL DEFAULT 'EUR' CHECK(currency='EUR'),
  quantity numeric(38,12) NOT NULL CHECK(quantity>0),
  previous_value_ht numeric(38,12) CHECK(previous_value_ht>=0),
  total_value_ht numeric(38,12) NOT NULL CHECK(total_value_ht>=0),
  value_delta numeric(38,12),
  previous_entry_id uuid NOT NULL REFERENCES public.stock_valuation_entries(id) ON DELETE RESTRICT,
  document_id uuid NOT NULL REFERENCES public.stock_documents(id) ON DELETE RESTRICT,
  document_sha256 text NOT NULL CHECK(document_sha256 ~ '^[0-9a-f]{64}$'),
  source_reliability text NOT NULL DEFAULT 'DECLARED' CHECK(source_reliability='DECLARED'),
  source_snapshot jsonb NOT NULL CHECK(jsonb_typeof(source_snapshot)='object' AND pg_column_size(source_snapshot)<=2097152),
  source_sha256 text NOT NULL CHECK(source_sha256 ~ '^[0-9a-f]{64}$'),
  request_id uuid NOT NULL UNIQUE,
  request_hash text NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'),
  created_by integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK(value_delta IS NOT DISTINCT FROM total_value_ht-previous_value_ht)
);
CREATE INDEX stock_value_adjustment_scope_idx ON public.stock_valuation_value_adjustments(article_id,stock_unit,created_at DESC,id DESC);
ALTER TABLE public.stock_valuation_entries ADD COLUMN value_adjustment_id uuid UNIQUE
  REFERENCES public.stock_valuation_value_adjustments(id) ON DELETE RESTRICT;

-- Replace only the two exact shape checks and uniqueness metadata. All existing
-- immutable-entry/balance/control trigger functions remain byte-for-byte intact.
DO $$
DECLARE found_count integer;target_name text;
BEGIN
  SELECT count(*),min(conname) INTO found_count,target_name FROM pg_constraint c
    WHERE c.conrelid='public.stock_valuation_entries'::regclass AND c.contype='c'
      AND cardinality(c.conkey)=1 AND EXISTS(SELECT 1 FROM pg_attribute a
        WHERE a.attrelid=c.conrelid AND a.attnum=ANY(c.conkey) AND a.attname='kind');
  IF found_count<>1 THEN RAISE EXCEPTION 'Expected preserved Stock entry kind check';END IF;
  EXECUTE format('ALTER TABLE public.stock_valuation_entries DROP CONSTRAINT %I',target_name);
  SELECT count(*),min(conname) INTO found_count,target_name FROM pg_constraint c
    WHERE c.conrelid='public.stock_valuation_entries'::regclass AND c.contype='c'
      AND EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.conrelid AND a.attnum=ANY(c.conkey) AND a.attname='kind')
      AND EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.conrelid AND a.attnum=ANY(c.conkey) AND a.attname='movement_id')
      AND EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.conrelid AND a.attnum=ANY(c.conkey) AND a.attname='source_sequence');
  IF found_count<>1 THEN RAISE EXCEPTION 'Expected preserved Stock posting shape check';END IF;
  EXECUTE format('ALTER TABLE public.stock_valuation_entries DROP CONSTRAINT %I',target_name);
  SELECT count(*),min(c.conname) INTO found_count,target_name FROM pg_constraint c JOIN pg_index i ON i.indexrelid=c.conindid
    WHERE c.conrelid='public.stock_valuation_entries'::regclass AND c.contype='u' AND i.indnullsnotdistinct
      AND (SELECT array_agg(a.attname::text ORDER BY x.ordinality) FROM unnest(c.conkey) WITH ORDINALITY x(num,ordinality)
        JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=x.num)=ARRAY['movement_id','article_id','owner_key','stock_unit','currency'];
  IF found_count<>1 THEN RAISE EXCEPTION 'Expected preserved Stock posting uniqueness';END IF;
  EXECUTE format('ALTER TABLE public.stock_valuation_entries DROP CONSTRAINT %I',target_name);
END $$;
ALTER TABLE public.stock_valuation_entries ADD CONSTRAINT stock_value_entry_kind_1007 CHECK(
  kind IN('OPENING','RECEIPT','ISSUE','SCRAP','RETURN','RECEIPT_REVERSAL','TRANSFER','ZERO','UNRESOLVED','VALUE_ADJUSTMENT'));
ALTER TABLE public.stock_valuation_entries ADD CONSTRAINT stock_value_entry_shape_1007 CHECK(
  (kind='OPENING' AND movement_id IS NULL AND source_sequence IS NULL)
  OR(kind='UNRESOLVED' AND owner_key IS NULL AND stock_unit IS NULL AND quantity_delta IS NULL
    AND value_delta IS NULL AND movement_value IS NULL AND reliability='UNKNOWN')
  OR(kind='ZERO' AND movement_id IS NOT NULL AND source_sequence IS NOT NULL AND quantity_delta=0 AND value_delta=0 AND movement_value IS NULL)
  OR(kind='VALUE_ADJUSTMENT' AND movement_id IS NULL AND source_sequence IS NOT NULL AND source_sequence>=0 AND owner_key='COMPANY' AND currency='EUR'
    AND stock_unit IS NOT NULL AND quantity_delta=0 AND reliability='DECLARED' AND value_adjustment_id IS NOT NULL)
  OR(kind NOT IN('OPENING','UNRESOLVED','ZERO','VALUE_ADJUSTMENT') AND movement_id IS NOT NULL AND source_sequence IS NOT NULL
    AND owner_key IS NOT NULL AND stock_unit IS NOT NULL AND quantity_delta IS NOT NULL));
ALTER TABLE public.stock_valuation_entries ADD CONSTRAINT stock_value_entry_adjustment_identity_1007
  CHECK((kind='VALUE_ADJUSTMENT')=(value_adjustment_id IS NOT NULL));
ALTER TABLE public.stock_valuation_entries ADD CONSTRAINT stock_value_posting_unique_1007
  UNIQUE NULLS NOT DISTINCT(movement_id,article_id,owner_key,stock_unit,currency,value_adjustment_id);

CREATE FUNCTION public.fn_stock_value_adjustment_guard_1007() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE candidate jsonb;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Financial adjustments are immutable; append a new documented adjustment' USING ERRCODE='23514';END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('stock:cump-projector:1',0));
  PERFORM 1 FROM public.stock_valuation_projector_control WHERE singleton FOR UPDATE;
  LOCK TABLE public.stock_valuation_movement_journal IN SHARE MODE;
  candidate:=public.fn_stock_value_candidate_1007(NEW.article_id,NEW.stock_unit);
  PERFORM 1 FROM public.stock_documents sd JOIN public.article_documents ad ON ad.document_id=sd.id
    WHERE sd.id=NEW.document_id AND ad.article_id=NEW.article_id AND ad.is_active AND sd.removed_at IS NULL
      AND sd.sha256=NEW.document_sha256 FOR SHARE OF sd,ad;
  IF NOT FOUND OR candidate->'eligible' IS DISTINCT FROM 'true'::jsonb
    OR EXISTS(SELECT 1 FROM public.stock_valuation_entries e WHERE e.id=NEW.entry_id)
    OR NEW.source_snapshot->'candidate' IS DISTINCT FROM candidate
    OR NEW.source_snapshot->>'schema_version' IS DISTINCT FROM '1'
    OR NEW.source_snapshot->>'adjustment_formula' IS DISTINCT FROM 'CERP-CUMP-VALUE-ADJUSTMENT-1.0.0'
    OR NEW.source_sha256<>encode(digest(NEW.source_snapshot::text,'sha256'),'hex')
    OR NEW.source_snapshot->'document'->>'id' IS DISTINCT FROM NEW.document_id::text
    OR NEW.source_snapshot->'document'->>'sha256' IS DISTINCT FROM NEW.document_sha256
    OR NEW.source_snapshot->'approval'->>'created_by' IS DISTINCT FROM NEW.created_by::text
    OR (NEW.source_snapshot->'approval'->>'total_value_ht')::numeric IS DISTINCT FROM NEW.total_value_ht
    OR candidate->>'previous_entry_id' IS DISTINCT FROM NEW.previous_entry_id::text
    OR (candidate->>'quantity')::numeric IS DISTINCT FROM NEW.quantity
    OR (candidate->'before_state'->>'value')::numeric IS DISTINCT FROM NEW.previous_value_ht
    OR (NEW.source_snapshot->'result'->'before'->>'quantity')::numeric IS DISTINCT FROM NEW.quantity
    OR (NEW.source_snapshot->'result'->'before'->>'value')::numeric IS DISTINCT FROM NEW.previous_value_ht
    OR (NEW.source_snapshot->'result'->'after'->>'quantity')::numeric IS DISTINCT FROM NEW.quantity
    OR (NEW.source_snapshot->'result'->'after'->>'value')::numeric IS DISTINCT FROM NEW.total_value_ht
    OR NEW.source_snapshot->'result'->'after'->>'reliability' IS DISTINCT FROM 'DECLARED'
    OR NEW.source_snapshot->'result'->'after'->>'sourceRef' IS DISTINCT FROM 'stock-valuation-entry:'||NEW.entry_id::text
    OR NEW.source_snapshot->'result'->>'formulaVersion' IS DISTINCT FROM 'CERP-CUMP-1.0.0'
    OR (NEW.source_snapshot->'result'->>'quantityDelta')::numeric IS DISTINCT FROM 0
    OR (NEW.source_snapshot->'result'->>'valueDelta')::numeric IS DISTINCT FROM NEW.value_delta
    OR (NEW.source_snapshot->'result'->>'movementValue')::numeric IS DISTINCT FROM abs(NEW.value_delta)
    OR NEW.source_snapshot->'result'->'unitCost' IS DISTINCT FROM 'null'::jsonb
    OR NEW.source_snapshot->'result'->'issues' IS DISTINCT FROM
      (CASE WHEN NEW.previous_value_ht IS NULL THEN '["PREVIOUS_VALUE_UNKNOWN"]'::jsonb ELSE '[]'::jsonb END)
    OR NEW.source_snapshot->'result'->>'movementReliability' IS DISTINCT FROM 'DECLARED' THEN
    RAISE EXCEPTION 'Financial adjustment requires current reconciled stock, its document and exact approval' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER stock_value_adjustment_immutable BEFORE INSERT OR UPDATE OR DELETE ON public.stock_valuation_value_adjustments
  FOR EACH ROW EXECUTE FUNCTION public.fn_stock_value_adjustment_guard_1007();
CREATE TRIGGER stock_value_adjustment_truncate_guard BEFORE TRUNCATE ON public.stock_valuation_value_adjustments
  FOR EACH STATEMENT EXECUTE FUNCTION public.fn_stock_value_adjustment_guard_1007();

CREATE FUNCTION public.fn_stock_value_adjustment_entry_guard_1007() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a public.stock_valuation_value_adjustments%ROWTYPE;
BEGIN
  IF TG_OP<>'INSERT' OR NEW.kind<>'VALUE_ADJUSTMENT' THEN RETURN NEW;END IF;
  SELECT * INTO a FROM public.stock_valuation_value_adjustments WHERE id=NEW.value_adjustment_id;
  IF NOT FOUND OR a.entry_id<>NEW.id OR a.article_id<>NEW.article_id OR a.stock_unit<>NEW.stock_unit
    OR a.source_sha256<>encode(digest(a.source_snapshot::text,'sha256'),'hex')
    OR NEW.source_snapshot->>'value_adjustment_id' IS DISTINCT FROM a.id::text
    OR NEW.source_snapshot->>'value_adjustment_sha256' IS DISTINCT FROM a.source_sha256
    OR NEW.source_snapshot->>'previous_entry_id' IS DISTINCT FROM a.previous_entry_id::text
    OR NEW.source_snapshot->'result' IS DISTINCT FROM a.source_snapshot->'result'
    OR NEW.issues IS DISTINCT FROM a.source_snapshot->'result'->'issues'
    OR (a.source_snapshot->'candidate'->'projector'->>'last_sequence')::bigint IS DISTINCT FROM NEW.source_sequence
    OR a.source_snapshot->'candidate' IS DISTINCT FROM public.fn_stock_value_candidate_1007(a.article_id,a.stock_unit) THEN
    RAISE EXCEPTION 'Financial entry requires its atomic approved adjustment and exact prior stock chain' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER stock_value_adjustment_entry_guard BEFORE INSERT ON public.stock_valuation_entries
  FOR EACH ROW EXECUTE FUNCTION public.fn_stock_value_adjustment_entry_guard_1007();

-- The deferred FK alone permits an unrelated entry with the promised UUID.
-- At commit, require the exact approved financial entry and its updated balance.
CREATE FUNCTION public.fn_stock_value_adjustment_commit_guard_1007() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.stock_valuation_entries e JOIN public.stock_valuation_balances b
    ON b.latest_entry_id=e.id AND (b.article_id,b.owner_key,b.stock_unit,b.currency)
      IS NOT DISTINCT FROM (e.article_id,e.owner_key,e.stock_unit,e.currency)
    WHERE e.id=NEW.entry_id AND e.value_adjustment_id=NEW.id AND e.kind='VALUE_ADJUSTMENT'
      AND e.article_id=NEW.article_id AND e.owner_key='COMPANY' AND e.stock_unit=NEW.stock_unit AND e.currency='EUR'
      AND e.source_snapshot->>'value_adjustment_sha256'=NEW.source_sha256
      AND b.quantity=NEW.quantity AND b.value=NEW.total_value_ht AND b.reliability='DECLARED'
      AND b.source_ref='stock-valuation-entry:'||NEW.entry_id::text AND b.latest_sequence=e.source_sequence) THEN
    RAISE EXCEPTION 'Financial correction must commit its exact entry and unchanged-quantity balance atomically' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER stock_value_adjustment_commit_guard AFTER INSERT ON public.stock_valuation_value_adjustments
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.fn_stock_value_adjustment_commit_guard_1007();

ALTER TABLE public.stock_valuation_value_adjustments OWNER TO cerp_app;
ALTER FUNCTION public.fn_stock_value_physical_1007(uuid,text) OWNER TO cerp_app;
ALTER FUNCTION public.fn_stock_value_candidate_1007(uuid,text) OWNER TO cerp_app;
ALTER FUNCTION public.fn_stock_value_adjustment_guard_1007() OWNER TO cerp_app;
ALTER FUNCTION public.fn_stock_value_adjustment_entry_guard_1007() OWNER TO cerp_app;
ALTER FUNCTION public.fn_stock_value_adjustment_commit_guard_1007() OWNER TO cerp_app;
COMMENT ON TABLE public.stock_valuation_value_adjustments IS
  'Documented total current company value, quantity unchanged, always DECLARED. Historical costs remain intact. No automatic invoice allocation or activation.';
COMMIT;
