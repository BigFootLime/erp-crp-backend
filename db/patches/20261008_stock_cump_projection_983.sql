-- Internal Stock read-model preparation. The worker stays PREPARED until all
-- owner adapters and coverage checks are connected. No CUMP activation here.
BEGIN;
SET LOCAL lock_timeout='10s';
CREATE TABLE public.stock_valuation_projector_control (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  mode text NOT NULL DEFAULT 'PREPARED' CHECK(mode IN('PREPARED','ACTIVE')),
  reporting_currency text NOT NULL DEFAULT 'EUR' CHECK(reporting_currency ~ '^[A-Z]{3}$'),
  formula_version text NOT NULL DEFAULT 'CERP-CUMP-1.0.0' CHECK(formula_version='CERP-CUMP-1.0.0'),
  initialized boolean NOT NULL DEFAULT false,
  last_sequence bigint NOT NULL DEFAULT 0 CHECK(last_sequence>=0),
  calculated_at timestamptz,
  last_error text
);
INSERT INTO public.stock_valuation_projector_control(singleton) VALUES(true);

CREATE TABLE public.stock_valuation_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  movement_id uuid REFERENCES public.stock_valuation_movement_journal(movement_id) ON DELETE RESTRICT,
  article_id uuid NOT NULL,
  owner_key text,
  stock_unit text,
  currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
  source_sequence bigint,
  kind text NOT NULL CHECK(kind IN('OPENING','RECEIPT','ISSUE','SCRAP','RETURN','RECEIPT_REVERSAL','TRANSFER','ZERO','UNRESOLVED')),
  formula_version text NOT NULL CHECK(formula_version='CERP-CUMP-1.0.0'),
  quantity_delta numeric(38,12),
  value_delta numeric(38,12),
  movement_value numeric(38,12) CHECK(movement_value>=0),
  reliability text NOT NULL CHECK(reliability IN('VERIFIED','DECLARED','UNKNOWN')),
  source_snapshot jsonb NOT NULL CHECK(jsonb_typeof(source_snapshot)='object'),
  source_sha256 text NOT NULL CHECK(source_sha256 ~ '^[0-9a-f]{64}$'),
  issues jsonb NOT NULL CHECK(jsonb_typeof(issues)='array'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE NULLS NOT DISTINCT(movement_id,article_id,owner_key,stock_unit,currency),
  CHECK((kind='OPENING' AND movement_id IS NULL AND source_sequence IS NULL)
    OR(kind='UNRESOLVED' AND owner_key IS NULL AND stock_unit IS NULL AND quantity_delta IS NULL
      AND value_delta IS NULL AND movement_value IS NULL AND reliability='UNKNOWN')
    OR(kind='ZERO' AND movement_id IS NOT NULL AND source_sequence IS NOT NULL AND quantity_delta=0
      AND value_delta=0 AND movement_value IS NULL)
    OR(kind NOT IN('OPENING','UNRESOLVED','ZERO') AND movement_id IS NOT NULL AND source_sequence IS NOT NULL
      AND owner_key IS NOT NULL AND stock_unit IS NOT NULL AND quantity_delta IS NOT NULL)),
  CHECK(owner_key IS NULL OR owner_key='COMPANY' OR(owner_key LIKE 'CLIENT:%' AND char_length(owner_key) BETWEEN 8 AND 262))
);
CREATE INDEX stock_valuation_entries_sequence_idx ON public.stock_valuation_entries(source_sequence);
CREATE INDEX stock_valuation_entries_scope_idx ON public.stock_valuation_entries(article_id,owner_key,stock_unit,currency,created_at DESC);
CREATE INDEX stock_acquisition_order_source_983_idx ON public.stock_valuation_acquisition_sources USING gin(source_snapshot jsonb_path_ops);

CREATE TABLE public.stock_valuation_balances (
  article_id uuid NOT NULL,
  owner_key text NOT NULL,
  stock_unit text NOT NULL CHECK(length(btrim(stock_unit))>0),
  currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
  quantity numeric(38,12) NOT NULL,
  value numeric(38,12) CHECK(value>=0),
  reliability text NOT NULL CHECK(reliability IN('VERIFIED','DECLARED','UNKNOWN')),
  source_ref text,
  latest_sequence bigint NOT NULL DEFAULT 0 CHECK(latest_sequence>=0),
  latest_entry_id uuid NOT NULL REFERENCES public.stock_valuation_entries(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(article_id,owner_key,stock_unit,currency),
  CHECK((value IS NULL AND reliability='UNKNOWN') OR(value IS NOT NULL AND reliability<>'UNKNOWN')),
  CHECK(quantity>=0 OR(value IS NULL AND reliability='UNKNOWN')),
  CHECK(quantity<>0 OR value IS NULL OR value=0),
  CHECK(value IS NULL OR quantity=0 OR length(btrim(source_ref))>0)
);

CREATE TABLE public.stock_valuation_acquisition_allocations (
  order_line_id uuid PRIMARY KEY,
  quantity numeric(38,12) NOT NULL CHECK(quantity>=0),
  basis_snapshot jsonb NOT NULL CHECK(jsonb_typeof(basis_snapshot)='object'),
  basis_sha256 text NOT NULL CHECK(basis_sha256 ~ '^[0-9a-f]{64}$'),
  poisoned boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE public.stock_valuation_return_allocations (
  original_movement_id uuid NOT NULL REFERENCES public.stock_valuation_movement_journal(movement_id) ON DELETE RESTRICT,
  owner_key text NOT NULL,
  stock_unit text NOT NULL,
  currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
  original_entry_id uuid NOT NULL REFERENCES public.stock_valuation_entries(id) ON DELETE RESTRICT,
  quantity numeric(38,12) NOT NULL CHECK(quantity>=0),
  value numeric(38,12) CHECK(value>=0),
  PRIMARY KEY(original_movement_id,owner_key,stock_unit,currency)
);

CREATE FUNCTION public.fn_stock_valuation_entry_guard_983() RETURNS trigger LANGUAGE plpgsql AS $$
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
      OR NEW.quantity_delta=0 AND (NEW.source_snapshot->'after_state'->>'value')::numeric=0 AND NEW.reliability='VERIFIED')) THEN
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
CREATE TRIGGER stock_valuation_entries_immutable BEFORE INSERT OR UPDATE OR DELETE
  ON public.stock_valuation_entries FOR EACH ROW EXECUTE FUNCTION public.fn_stock_valuation_entry_guard_983();
CREATE TRIGGER stock_valuation_entries_truncate_guard BEFORE TRUNCATE
  ON public.stock_valuation_entries FOR EACH STATEMENT EXECUTE FUNCTION public.fn_stock_valuation_entry_guard_983();

CREATE FUNCTION public.fn_stock_valuation_balance_guard_983() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN('DELETE','TRUNCATE') THEN
    RAISE EXCEPTION 'Stock valuation balances require a projection generation' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.stock_valuation_entries e WHERE e.id=NEW.latest_entry_id
    AND e.article_id=NEW.article_id AND e.owner_key=NEW.owner_key AND e.stock_unit=NEW.stock_unit AND e.currency=NEW.currency
    AND COALESCE(e.source_sequence,0)=NEW.latest_sequence
    AND(e.source_snapshot->'after_state'->>'quantity')::numeric=NEW.quantity
    AND(e.source_snapshot->'after_state'->>'value')::numeric IS NOT DISTINCT FROM NEW.value
    AND e.source_snapshot->'after_state'->>'reliability'=NEW.reliability
    AND e.source_snapshot->'after_state'->>'sourceRef' IS NOT DISTINCT FROM NEW.source_ref) THEN
    RAISE EXCEPTION 'Stock valuation balance requires its immutable latest entry' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND (NEW.latest_sequence<OLD.latest_sequence
    OR(NEW.article_id,NEW.owner_key,NEW.stock_unit,NEW.currency) IS DISTINCT FROM(OLD.article_id,OLD.owner_key,OLD.stock_unit,OLD.currency)) THEN
    RAISE EXCEPTION 'Stock valuation balance cannot change its scope or rewind' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER stock_valuation_balance_owner_guard BEFORE INSERT OR UPDATE OR DELETE
  ON public.stock_valuation_balances FOR EACH ROW EXECUTE FUNCTION public.fn_stock_valuation_balance_guard_983();
CREATE TRIGGER stock_valuation_balance_truncate_guard BEFORE TRUNCATE
  ON public.stock_valuation_balances FOR EACH STATEMENT EXECUTE FUNCTION public.fn_stock_valuation_balance_guard_983();

CREATE FUNCTION public.fn_stock_valuation_projector_control_guard_983() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN('DELETE','TRUNCATE') THEN
    RAISE EXCEPTION 'Stock projector control cannot be removed' USING ERRCODE='23514';
  END IF;
  IF (NEW.reporting_currency,NEW.formula_version) IS DISTINCT FROM (OLD.reporting_currency,OLD.formula_version)
    OR NEW.last_sequence<OLD.last_sequence OR(OLD.initialized AND NOT NEW.initialized) THEN
    RAISE EXCEPTION 'Stock projector requires a new generation to change its basis or rewind' USING ERRCODE='23514';
  END IF;
  IF NEW.last_sequence>OLD.last_sequence AND (NEW.mode<>'ACTIVE' OR NOT NEW.initialized
    OR EXISTS(SELECT 1 FROM public.stock_valuation_movement_journal j
      WHERE j.sequence>OLD.last_sequence AND j.sequence<=NEW.last_sequence
      AND NOT EXISTS(SELECT 1 FROM public.stock_valuation_entries e WHERE e.movement_id=j.movement_id))) THEN
    RAISE EXCEPTION 'Stock projector cursor cannot pass an unrecorded immutable posting' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER stock_valuation_projector_control_owner_guard BEFORE UPDATE OR DELETE
  ON public.stock_valuation_projector_control FOR EACH ROW EXECUTE FUNCTION public.fn_stock_valuation_projector_control_guard_983();
CREATE TRIGGER stock_valuation_projector_control_truncate_guard BEFORE TRUNCATE
  ON public.stock_valuation_projector_control FOR EACH STATEMENT EXECUTE FUNCTION public.fn_stock_valuation_projector_control_guard_983();

ALTER TABLE public.stock_valuation_projector_control OWNER TO cerp_app;
ALTER TABLE public.stock_valuation_entries OWNER TO cerp_app;
ALTER TABLE public.stock_valuation_balances OWNER TO cerp_app;
ALTER TABLE public.stock_valuation_acquisition_allocations OWNER TO cerp_app;
ALTER TABLE public.stock_valuation_return_allocations OWNER TO cerp_app;
ALTER FUNCTION public.fn_stock_valuation_entry_guard_983() OWNER TO cerp_app;
ALTER FUNCTION public.fn_stock_valuation_balance_guard_983() OWNER TO cerp_app;
ALTER FUNCTION public.fn_stock_valuation_projector_control_guard_983() OWNER TO cerp_app;
COMMENT ON TABLE public.stock_valuation_projector_control IS
  'Stock-owned CUMP projector. PREPARED is intentionally inactive; capture boundaries remain historical facts. No operator cost input.';
COMMIT;
