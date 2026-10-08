-- Explicit documented opening values, never reconstructed from catalogue prices.
-- No activation, financial entries, physical stock changes or automatic approval.
BEGIN;
SET LOCAL lock_timeout='10s';

CREATE FUNCTION public.fn_stock_opening_scope_1004(raw text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN token IN ('pc','pce','pces','pcs','piece','pieces','pièce','pièces',
    'unit','units','unite','unites','unité','unités') THEN 'u' ELSE NULLIF(token,'') END
  FROM (SELECT lower(normalize(btrim(raw),NFKC)) AS token) n
$$;

-- LEVEL already contains BATCH. Subtract client-owned batches exactly once.
-- All observations for the article are checked, even outside the selected unit.
CREATE FUNCTION public.fn_stock_opening_candidate_1004(article uuid, unit_code text) RETURNS jsonb
LANGUAGE sql STABLE AS $$
WITH raw AS MATERIALIZED (
  SELECT o.*,public.fn_stock_opening_scope_1004(o.source_snapshot->>'stock_unit') AS unit,
    o.source_snapshot->>'owner_client_id' AS owner,
    CASE WHEN length(o.source_snapshot->>'quantity_total')<=80
      AND o.source_snapshot->>'quantity_total' ~ '^-?[0-9]+(\.[0-9]{1,12})?$'
      THEN (o.source_snapshot->>'quantity_total')::numeric END AS total,
    CASE WHEN length(o.source_snapshot->>'quantity_depreciated')<=80
      AND o.source_snapshot->>'quantity_depreciated' ~ '^[0-9]+(\.[0-9]{1,12})?$'
      THEN (o.source_snapshot->>'quantity_depreciated')::numeric END AS depreciated,
    o.source_sha256=encode(digest(o.source_snapshot::text,'sha256'),'hex')
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
  FROM public.stock_valuation_opening_quantities o WHERE o.article_id=article ORDER BY o.id LIMIT 10001
), levels AS (
  SELECT l.*,count(b.id) AS batches_count,COALESCE(sum(b.total),0) AS batches_total,
    COALESCE(sum(b.depreciated),0) AS batches_depreciated,
    COALESCE(sum(b.total-b.depreciated) FILTER(WHERE b.owner IS NOT NULL),0) AS client_quantity
  FROM raw l LEFT JOIN raw b ON b.stock_level_id=l.stock_level_id AND b.stock_batch_id IS NOT NULL
  WHERE l.stock_batch_id IS NULL
  GROUP BY l.id,l.stock_level_id,l.stock_batch_id,l.article_id,l.captured_at,l.source_snapshot,
    l.source_sha256,l.unit,l.owner,l.total,l.depreciated,l.proof_valid
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

CREATE TABLE public.stock_valuation_opening_bases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  article_id uuid NOT NULL REFERENCES public.articles(id) ON DELETE RESTRICT,
  owner_key text NOT NULL DEFAULT 'COMPANY' CHECK(owner_key='COMPANY'),
  stock_unit text NOT NULL CHECK(length(stock_unit) BETWEEN 1 AND 32),
  currency text NOT NULL DEFAULT 'EUR' CHECK(currency='EUR'),
  quantity numeric(38,12) NOT NULL CHECK(quantity>0),
  total_value_ht numeric(38,12) NOT NULL CHECK(total_value_ht>=0),
  document_id uuid NOT NULL REFERENCES public.stock_documents(id) ON DELETE RESTRICT,
  document_sha256 text NOT NULL CHECK(document_sha256 ~ '^[0-9a-f]{64}$'),
  source_reliability text NOT NULL DEFAULT 'DECLARED' CHECK(source_reliability='DECLARED'),
  source_snapshot jsonb NOT NULL CHECK(jsonb_typeof(source_snapshot)='object' AND pg_column_size(source_snapshot)<=2097152),
  source_sha256 text NOT NULL CHECK(source_sha256 ~ '^[0-9a-f]{64}$'),
  request_id uuid NOT NULL UNIQUE,
  request_hash text NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'),
  created_by integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(article_id,owner_key,stock_unit,currency)
);

CREATE FUNCTION public.fn_stock_opening_basis_guard_1004() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE candidate jsonb;
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'Opening bases are immutable; append a separate financial correction' USING ERRCODE='23514';
  END IF;
  PERFORM 1 FROM public.stock_valuation_projector_control c
    WHERE c.mode='PREPARED' AND NOT c.initialized AND c.last_sequence=0 AND c.reporting_currency=NEW.currency FOR SHARE;
  IF NOT FOUND OR EXISTS(SELECT 1 FROM public.stock_valuation_entries e WHERE e.article_id=NEW.article_id) THEN
    RAISE EXCEPTION 'Opening declaration requires a prepared, uninitialized Stock projector' USING ERRCODE='23514';
  END IF;
  candidate:=public.fn_stock_opening_candidate_1004(NEW.article_id,NEW.stock_unit);
  IF candidate->'eligible' IS DISTINCT FROM 'true'::jsonb
    OR (candidate->>'quantity')::numeric IS DISTINCT FROM NEW.quantity
    OR NEW.source_snapshot->'opening' IS DISTINCT FROM candidate
    OR NEW.source_snapshot->>'schema_version' IS DISTINCT FROM '1'
    OR NEW.source_snapshot->'document'->>'id' IS DISTINCT FROM NEW.document_id::text
    OR NEW.source_snapshot->'document'->>'sha256' IS DISTINCT FROM NEW.document_sha256
    OR NEW.source_snapshot->'approval'->>'created_by' IS DISTINCT FROM NEW.created_by::text
    OR (NEW.source_snapshot->'approval'->>'total_value_ht')::numeric IS DISTINCT FROM NEW.total_value_ht
    OR NEW.source_sha256<>encode(digest(NEW.source_snapshot::text,'sha256'),'hex')
    OR NOT EXISTS(SELECT 1 FROM public.article_documents ad JOIN public.stock_documents sd ON sd.id=ad.document_id
      WHERE ad.article_id=NEW.article_id AND ad.document_id=NEW.document_id AND ad.is_active
        AND sd.removed_at IS NULL AND sd.sha256=NEW.document_sha256) THEN
    RAISE EXCEPTION 'Opening declaration requires reconciled quantities, its document and exact approval proof' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER stock_opening_basis_immutable BEFORE INSERT OR UPDATE OR DELETE
  ON public.stock_valuation_opening_bases FOR EACH ROW EXECUTE FUNCTION public.fn_stock_opening_basis_guard_1004();
CREATE TRIGGER stock_opening_basis_truncate_guard BEFORE TRUNCATE
  ON public.stock_valuation_opening_bases FOR EACH STATEMENT EXECUTE FUNCTION public.fn_stock_opening_basis_guard_1004();

-- Called by the entry guard as well as the internal source adapter. It accepts
-- only the declared base for this exact frozen opening and company scope.
CREATE FUNCTION public.fn_stock_opening_entry_basis_1004(article uuid,owner text,unit_code text,curr text,
  quantity numeric,value numeric,proof jsonb) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT owner='COMPANY' AND curr='EUR' AND quantity>0 AND EXISTS(
    SELECT 1 FROM public.stock_valuation_opening_bases b
    WHERE b.id::text=proof->>'opening_basis_id' AND b.article_id=article AND b.owner_key=owner
      AND b.stock_unit=unit_code AND b.currency=curr AND b.quantity=quantity AND b.total_value_ht=value
      AND b.source_reliability='DECLARED' AND b.source_sha256=proof->>'opening_basis_sha256'
      AND b.source_sha256=encode(digest(b.source_snapshot::text,'sha256'),'hex')
      AND b.source_snapshot->'opening'=public.fn_stock_opening_candidate_1004(article,unit_code)
      AND b.source_snapshot->'opening'->'opening_ids'=proof->'opening_ids')
$$;

ALTER TABLE public.stock_valuation_opening_bases OWNER TO cerp_app;
ALTER FUNCTION public.fn_stock_opening_scope_1004(text) OWNER TO cerp_app;
ALTER FUNCTION public.fn_stock_opening_candidate_1004(uuid,text) OWNER TO cerp_app;
ALTER FUNCTION public.fn_stock_opening_basis_guard_1004() OWNER TO cerp_app;
ALTER FUNCTION public.fn_stock_opening_entry_basis_1004(uuid,text,text,text,numeric,numeric,jsonb) OWNER TO cerp_app;
COMMENT ON TABLE public.stock_valuation_opening_bases IS
  'Explicit documented company opening value in EUR. DECLARED, never catalogue-derived or automatically verified. PREPARED remains inactive.';
-- The preserved Stock entry guard is extended below; all other checks remain.

CREATE OR REPLACE FUNCTION public.fn_stock_valuation_entry_guard_983() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prior public.stock_valuation_balances%ROWTYPE;
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'Stock valuation entries are immutable; append a justified correction' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.stock_valuation_projector_control c WHERE c.mode='ACTIVE'
    AND c.reporting_currency=NEW.currency AND c.formula_version=NEW.formula_version)
    OR NEW.source_sha256<>encode(digest(NEW.source_snapshot::text,'sha256'),'hex') THEN
    RAISE EXCEPTION 'Stock valuation entry requires the active Stock projector and its proof' USING ERRCODE='23514';
  END IF;
  IF NEW.movement_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.stock_valuation_movement_journal j
    WHERE j.movement_id=NEW.movement_id AND j.article_id=NEW.article_id AND j.sequence=NEW.source_sequence
      AND NEW.source_snapshot->>'stock_source_sha256'=j.source_sha256) THEN
    RAISE EXCEPTION 'Stock valuation entry is not linked to its immutable posting' USING ERRCODE='23514';
  END IF;
  IF NEW.kind='OPENING' AND (
    NEW.owner_key IS NULL OR NEW.stock_unit IS NULL OR NEW.quantity_delta IS NULL
    OR NEW.value_delta IS NOT NULL OR NEW.movement_value IS NOT NULL
    OR (NEW.source_snapshot->'after_state'->>'quantity')::numeric IS DISTINCT FROM NEW.quantity_delta
    OR NOT ((NEW.source_snapshot->'after_state'->>'value') IS NULL AND NEW.reliability='UNKNOWN'
      OR NEW.quantity_delta=0 AND (NEW.source_snapshot->'after_state'->>'value')::numeric=0 AND NEW.reliability='VERIFIED'
      OR NEW.reliability='DECLARED' AND NEW.source_snapshot->'after_state'->>'reliability'='DECLARED'
        AND public.fn_stock_opening_entry_basis_1004(NEW.article_id,NEW.owner_key,NEW.stock_unit,NEW.currency,
        NEW.quantity_delta,(NEW.source_snapshot->'after_state'->>'value')::numeric,NEW.source_snapshot))) THEN
    RAISE EXCEPTION 'Opening quantities cannot introduce an unsupported historical price' USING ERRCODE='23514';
  END IF;
  IF NEW.kind='UNRESOLVED' AND NEW.source_snapshot->'blocking' IS DISTINCT FROM 'true'::jsonb THEN
    RAISE EXCEPTION 'Unresolved Stock evidence must suppress financial publication' USING ERRCODE='23514';
  END IF;
  IF NEW.kind NOT IN('OPENING','ZERO','UNRESOLVED') THEN
    SELECT * INTO prior FROM public.stock_valuation_balances
      WHERE article_id=NEW.article_id AND owner_key=NEW.owner_key AND stock_unit=NEW.stock_unit AND currency=NEW.currency;
    IF NOT FOUND OR NEW.source_snapshot->>'previous_entry_id' IS DISTINCT FROM prior.latest_entry_id::text
      OR (NEW.source_snapshot->'before_state'->>'quantity')::numeric IS DISTINCT FROM prior.quantity
      OR (NEW.source_snapshot->'before_state'->>'value')::numeric IS DISTINCT FROM prior.value
      OR NEW.source_snapshot->'before_state'->>'reliability' IS DISTINCT FROM prior.reliability
      OR NEW.source_snapshot->'before_state'->>'sourceRef' IS DISTINCT FROM prior.source_ref
      OR NEW.source_snapshot->'result'->'before' IS DISTINCT FROM NEW.source_snapshot->'before_state'
      OR NEW.source_snapshot->'result'->'after' IS DISTINCT FROM NEW.source_snapshot->'after_state'
      OR NEW.source_snapshot->'result'->>'formulaVersion' IS DISTINCT FROM NEW.formula_version
      OR (NEW.source_snapshot->'result'->>'quantityDelta')::numeric IS DISTINCT FROM NEW.quantity_delta
      OR (NEW.source_snapshot->'result'->>'valueDelta')::numeric IS DISTINCT FROM NEW.value_delta
      OR (NEW.source_snapshot->'result'->>'movementValue')::numeric IS DISTINCT FROM NEW.movement_value
      OR NEW.source_snapshot->'result'->>'movementReliability' IS DISTINCT FROM NEW.reliability THEN
      RAISE EXCEPTION 'Stock valuation transition must extend its exact immutable balance chain' USING ERRCODE='23514';
    END IF;
  END IF;
  IF NEW.kind NOT IN('ZERO','UNRESOLVED') AND (
    NEW.source_snapshot->'after_state'->'scope'->>'articleId' IS DISTINCT FROM NEW.article_id::text
    OR NEW.source_snapshot->'after_state'->'scope'->>'owner' IS DISTINCT FROM NEW.owner_key
    OR NEW.source_snapshot->'after_state'->'scope'->>'unit' IS DISTINCT FROM NEW.stock_unit
    OR NEW.source_snapshot->'after_state'->'scope'->>'currency' IS DISTINCT FROM NEW.currency) THEN
    RAISE EXCEPTION 'Stock valuation state must retain its article, owner, unit and currency' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
COMMIT;
