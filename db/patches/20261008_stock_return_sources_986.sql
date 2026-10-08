-- Future remnant links and immutable allocation events. CUMP stays PREPARED.
BEGIN;
SET LOCAL lock_timeout='10s';
LOCK TABLE public.stock_movements IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.stock_valuation_projector_control IN SHARE ROW EXCLUSIVE MODE;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.stock_valuation_projector_control WHERE singleton AND mode='PREPARED'
    AND NOT initialized AND last_sequence=0) OR EXISTS(SELECT 1 FROM public.stock_valuation_entries)
    OR EXISTS(SELECT 1 FROM public.stock_valuation_return_allocations) THEN
    RAISE EXCEPTION 'Return allocation preparation requires the inactive empty Stock projector';
  END IF;
END $$;

CREATE TABLE public.stock_valuation_return_boundary (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  schema_version integer NOT NULL DEFAULT 1 CHECK(schema_version=1)
);
INSERT INTO public.stock_valuation_return_boundary(singleton) VALUES(true);
CREATE TRIGGER stock_return_boundary_immutable BEFORE INSERT OR UPDATE OR DELETE
  ON public.stock_valuation_return_boundary FOR EACH ROW EXECUTE FUNCTION public.fn_stock_valuation_boundary_guard_977();
CREATE TRIGGER stock_return_boundary_truncate_guard BEFORE TRUNCATE
  ON public.stock_valuation_return_boundary FOR EACH STATEMENT EXECUTE FUNCTION public.fn_stock_valuation_boundary_guard_977();

CREATE TABLE public.stock_valuation_return_sources (
  movement_id uuid PRIMARY KEY REFERENCES public.stock_valuation_movement_journal(movement_id) ON DELETE RESTRICT,
  posting_transaction text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  source_snapshot jsonb NOT NULL CHECK(jsonb_typeof(source_snapshot)='object'),
  source_sha256 text NOT NULL CHECK(source_sha256 ~ '^[0-9a-f]{64}$'),
  source_issues jsonb NOT NULL CHECK(jsonb_typeof(source_issues)='array')
);
CREATE FUNCTION public.fn_stock_return_source_guard_986() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' OR pg_trigger_depth()<3 OR NEW.posting_transaction<>pg_current_xact_id()::text
    OR NEW.source_sha256<>encode(digest(NEW.source_snapshot::text,'sha256'),'hex')
    OR NOT EXISTS(SELECT 1 FROM public.stock_valuation_movement_journal j WHERE j.movement_id=NEW.movement_id
      AND j.posting_transaction=NEW.posting_transaction
      AND NEW.source_snapshot->>'movement_id'=j.movement_id::text
      AND NEW.source_snapshot->>'stock_source_sha256'=j.source_sha256) THEN
    RAISE EXCEPTION 'Stock return sources require the immutable capture transaction' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER stock_return_sources_immutable BEFORE INSERT OR UPDATE OR DELETE
  ON public.stock_valuation_return_sources FOR EACH ROW EXECUTE FUNCTION public.fn_stock_return_source_guard_986();
CREATE TRIGGER stock_return_sources_truncate_guard BEFORE TRUNCATE
  ON public.stock_valuation_return_sources FOR EACH STATEMENT EXECUTE FUNCTION public.fn_stock_return_source_guard_986();

CREATE FUNCTION public.fn_stock_return_source_capture_986() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE remnants jsonb; snapshot jsonb; issues jsonb:='[]'::jsonb; reason text; source_count integer;
BEGIN
  SELECT reason_code INTO reason FROM public.stock_movements WHERE id=NEW.movement_id;
  IF NEW.source_snapshot->>'reversal_of_id' IS NULL AND reason IS DISTINCT FROM 'CHUTE_MATIERE'
    AND NOT EXISTS(SELECT 1 FROM public.production_material_remnants r WHERE r.stock_movement_id=NEW.movement_id)
    THEN RETURN NULL; END IF;
  -- The journal is inserted by the deferred posting trigger: debit and remnant
  -- registries are complete. No physical row lock is introduced at commit.
  SELECT count(*)::integer,COALESCE(jsonb_agg(jsonb_build_object(
    'id',r.id::text,'debit_id',r.debit_id::text,'source_reservation_id',r.source_reservation_id::text,
    'lot_id',r.lot_id::text,'quantity',r.quantity::text,'unit',r.unit,'dimensions',r.dimensions,
    'of_id',d.of_id::text,'operation_id',d.operation_id::text,'compensates_id',d.compensates_id::text,
    'need_id',s.need_id::text,'source_actual_quantity',s.actual_qty::text,
    'original_movement_id',s.stock_movement_id::text,'original_stock_source_sha256',j.source_sha256,
    'original_stock_source',j.source_snapshot
  ) ORDER BY r.id),'[]'::jsonb) INTO source_count,remnants
  FROM public.production_material_remnants r
    LEFT JOIN public.production_material_debits d ON d.id=r.debit_id
    LEFT JOIN public.production_material_debit_sources s ON s.debit_id=r.debit_id AND s.reservation_id=r.source_reservation_id
    LEFT JOIN public.stock_valuation_movement_journal j ON j.movement_id=s.stock_movement_id
  WHERE r.stock_movement_id=NEW.movement_id;
  IF reason='CHUTE_MATIERE' AND source_count<>1 THEN issues:=issues||jsonb_build_array('MATERIAL_RETURN_SOURCE_CARDINALITY'); END IF;
  IF source_count>0 AND NEW.source_snapshot->>'reversal_of_id' IS NOT NULL THEN
    issues:=issues||jsonb_build_array('MATERIAL_RETURN_SOURCE_AMBIGUOUS'); END IF;
  snapshot:=jsonb_build_object('schema_version',1,'movement_id',NEW.movement_id::text,
    'stock_source_sha256',NEW.source_sha256,'reason_code',reason,
    'reversal_of_id',NEW.source_snapshot->>'reversal_of_id','remnants',remnants);
  INSERT INTO public.stock_valuation_return_sources(movement_id,posting_transaction,source_snapshot,source_sha256,source_issues)
  VALUES(NEW.movement_id,NEW.posting_transaction,snapshot,encode(digest(snapshot::text,'sha256'),'hex'),issues);
  RETURN NULL;
END $$;
CREATE TRIGGER stock_return_source_capture_986 AFTER INSERT ON public.stock_valuation_movement_journal
  FOR EACH ROW EXECUTE FUNCTION public.fn_stock_return_source_capture_986();

CREATE TABLE public.stock_valuation_return_allocation_events (
  id uuid PRIMARY KEY,
  original_movement_id uuid NOT NULL REFERENCES public.stock_valuation_movement_journal(movement_id) ON DELETE RESTRICT,
  original_entry_id uuid NOT NULL REFERENCES public.stock_valuation_entries(id) ON DELETE RESTRICT,
  applied_entry_id uuid NOT NULL REFERENCES public.stock_valuation_entries(id) DEFERRABLE INITIALLY DEFERRED,
  applied_movement_id uuid NOT NULL REFERENCES public.stock_valuation_movement_journal(movement_id) ON DELETE RESTRICT,
  owner_key text NOT NULL,
  stock_unit text NOT NULL,
  currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
  previous_event_id uuid REFERENCES public.stock_valuation_return_allocation_events(id) ON DELETE RESTRICT,
  inverse_of_event_id uuid REFERENCES public.stock_valuation_return_allocation_events(id) ON DELETE RESTRICT,
  quantity_delta numeric(38,12) NOT NULL CHECK(quantity_delta<>0),
  value_delta numeric(38,12),
  source_snapshot jsonb NOT NULL CHECK(jsonb_typeof(source_snapshot)='object'),
  source_sha256 text NOT NULL CHECK(source_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(applied_entry_id,original_movement_id,owner_key,stock_unit,currency)
);
CREATE INDEX stock_return_allocation_applied_986_idx ON public.stock_valuation_return_allocation_events(applied_entry_id);
CREATE INDEX stock_return_allocation_inverse_986_idx ON public.stock_valuation_return_allocation_events(inverse_of_event_id)
  WHERE inverse_of_event_id IS NOT NULL;
ALTER TABLE public.stock_valuation_return_allocations ADD COLUMN latest_event_id uuid
  REFERENCES public.stock_valuation_return_allocation_events(id) ON DELETE RESTRICT;

CREATE FUNCTION public.fn_stock_return_allocation_guard_986() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE original public.stock_valuation_entries%ROWTYPE; prior public.stock_valuation_return_allocations%ROWTYPE;
  before_qty numeric:=0; before_value numeric; after_qty numeric; after_value numeric; previous_id uuid;
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'Stock return allocation events are immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.source_sha256<>encode(digest(NEW.source_snapshot::text,'sha256'),'hex')
    OR NOT EXISTS(SELECT 1 FROM public.stock_valuation_projector_control WHERE mode='ACTIVE' AND reporting_currency=NEW.currency)
    OR NOT EXISTS(SELECT 1 FROM public.stock_valuation_movement_journal j WHERE j.movement_id=NEW.applied_movement_id
      AND j.source_sha256=NEW.source_snapshot->>'stock_source_sha256') THEN
    RAISE EXCEPTION 'Stock return allocation requires the active projector and immutable posting proof' USING ERRCODE='23514';
  END IF;
  SELECT * INTO original FROM public.stock_valuation_entries e WHERE e.id=NEW.original_entry_id
    AND e.movement_id=NEW.original_movement_id AND e.owner_key=NEW.owner_key AND e.stock_unit=NEW.stock_unit AND e.currency=NEW.currency;
  IF NOT FOUND OR original.quantity_delta IS NULL OR original.quantity_delta=0 THEN
    RAISE EXCEPTION 'Stock return allocation requires its exact original valuation entry' USING ERRCODE='23514';
  END IF;
  before_value:=CASE WHEN original.movement_value IS NULL THEN NULL ELSE 0 END;
  SELECT * INTO prior FROM public.stock_valuation_return_allocations c
    WHERE c.original_movement_id=NEW.original_movement_id AND c.owner_key=NEW.owner_key AND c.stock_unit=NEW.stock_unit AND c.currency=NEW.currency;
  IF FOUND THEN
    IF prior.original_entry_id<>NEW.original_entry_id THEN RAISE EXCEPTION 'Return cursor original entry changed' USING ERRCODE='23514'; END IF;
    before_qty:=prior.quantity; before_value:=prior.value; previous_id:=prior.latest_event_id;
  END IF;
  IF NEW.previous_event_id IS DISTINCT FROM previous_id
    OR (NEW.source_snapshot->'before_cursor'->>'quantity')::numeric IS DISTINCT FROM before_qty
    OR (NEW.source_snapshot->'before_cursor'->>'value')::numeric IS DISTINCT FROM before_value
    OR NEW.source_snapshot->'before_cursor'->>'originalMovementRef' IS DISTINCT FROM NEW.original_movement_id::text THEN
    RAISE EXCEPTION 'Return allocation must extend its exact net cursor' USING ERRCODE='23514';
  END IF;
  after_qty:=before_qty+NEW.quantity_delta;
  IF after_qty<0 OR after_qty>abs(original.quantity_delta) THEN
    RAISE EXCEPTION 'Return allocation quantity exceeds its original posting' USING ERRCODE='23514';
  END IF;
  IF original.movement_value IS NULL THEN
    IF before_value IS NOT NULL OR NEW.value_delta IS NOT NULL THEN RAISE EXCEPTION 'Unknown original value must remain unknown' USING ERRCODE='23514'; END IF;
    after_value:=NULL;
  ELSE
    IF before_value IS NULL OR NEW.value_delta IS NULL
      OR(NEW.quantity_delta>0 AND NEW.value_delta<0) OR(NEW.quantity_delta<0 AND NEW.value_delta>0) THEN
      RAISE EXCEPTION 'Return allocation value does not follow its original proof' USING ERRCODE='23514';
    END IF;
    after_value:=before_value+NEW.value_delta;
    IF after_value<0 OR after_value>original.movement_value OR(after_qty=0 AND after_value<>0)
      OR(after_qty=abs(original.quantity_delta) AND after_value<>original.movement_value) THEN
      RAISE EXCEPTION 'Return allocation value exceeds its exact original amount' USING ERRCODE='23514';
    END IF;
  END IF;
  IF (NEW.source_snapshot->'after_cursor'->>'quantity')::numeric IS DISTINCT FROM after_qty
    OR (NEW.source_snapshot->'after_cursor'->>'value')::numeric IS DISTINCT FROM after_value
    OR NEW.source_snapshot->'after_cursor'->>'originalMovementRef' IS DISTINCT FROM NEW.original_movement_id::text THEN
    RAISE EXCEPTION 'Return allocation after-state does not match its signed effect' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER stock_return_allocation_immutable BEFORE INSERT OR UPDATE OR DELETE
  ON public.stock_valuation_return_allocation_events FOR EACH ROW EXECUTE FUNCTION public.fn_stock_return_allocation_guard_986();
CREATE TRIGGER stock_return_allocation_truncate_guard BEFORE TRUNCATE
  ON public.stock_valuation_return_allocation_events FOR EACH STATEMENT EXECUTE FUNCTION public.fn_stock_return_allocation_guard_986();

-- Cancelling a cancellation restores the allocation. Bound net signed effects
-- over the inverse tree, never the gross sum of all historical cancellations.
CREATE FUNCTION public.fn_stock_return_inverse_bounds_986(event_id uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  WITH RECURSIVE ancestors AS (
    SELECT id,inverse_of_event_id,0 AS depth FROM public.stock_valuation_return_allocation_events WHERE id=event_id
    UNION ALL
    SELECT e.id,e.inverse_of_event_id,a.depth+1 FROM ancestors a
      JOIN public.stock_valuation_return_allocation_events e ON e.id=a.inverse_of_event_id WHERE a.depth<65
  ), effects AS (
    SELECT a.id AS root,e.id,e.quantity_delta,e.value_delta,1 AS depth FROM ancestors a
      JOIN public.stock_valuation_return_allocation_events e ON e.inverse_of_event_id=a.id
    UNION ALL
    SELECT p.root,e.id,e.quantity_delta,e.value_delta,p.depth+1 FROM effects p
      JOIN public.stock_valuation_return_allocation_events e ON e.inverse_of_event_id=p.id WHERE p.depth<65
  ), totals AS (
    SELECT r.id,r.quantity_delta,r.value_delta,
      -sign(r.quantity_delta)*COALESCE(sum(e.quantity_delta),0) AS inverted_quantity,
      -sign(r.quantity_delta)*sum(e.value_delta) AS inverted_value
    FROM ancestors a JOIN public.stock_valuation_return_allocation_events r ON r.id=a.id
      LEFT JOIN effects e ON e.root=r.id GROUP BY r.id,r.quantity_delta,r.value_delta
  ) SELECT EXISTS(SELECT 1 FROM ancestors)
    AND NOT EXISTS(SELECT 1 FROM ancestors WHERE depth=65)
    AND NOT EXISTS(SELECT 1 FROM effects WHERE depth=65)
    AND NOT EXISTS(SELECT 1 FROM totals WHERE inverted_quantity<0 OR inverted_quantity>abs(quantity_delta)
      OR (value_delta IS NULL AND inverted_value IS NOT NULL)
      OR (value_delta IS NOT NULL AND (inverted_value IS NULL OR inverted_value<0 OR inverted_value>abs(value_delta)
        OR (inverted_quantity=0 AND inverted_value<>0)
        OR (inverted_quantity=abs(quantity_delta) AND inverted_value<>abs(value_delta)))))
$$;

CREATE FUNCTION public.fn_stock_return_allocation_link_guard_986() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE applied public.stock_valuation_entries%ROWTYPE; original public.stock_valuation_entries%ROWTYPE;
  inverse public.stock_valuation_return_allocation_events%ROWTYPE;
BEGIN
  SELECT * INTO applied FROM public.stock_valuation_entries WHERE id=NEW.applied_entry_id;
  IF NOT FOUND OR applied.movement_id<>NEW.applied_movement_id OR applied.kind NOT IN('RETURN','RECEIPT_REVERSAL')
    OR(applied.owner_key,applied.stock_unit,applied.currency) IS DISTINCT FROM(NEW.owner_key,NEW.stock_unit,NEW.currency)
    OR abs(applied.quantity_delta) IS DISTINCT FROM abs(NEW.quantity_delta)
    OR applied.movement_value IS DISTINCT FROM abs(NEW.value_delta)
    OR applied.source_snapshot->>'stock_source_sha256' IS DISTINCT FROM NEW.source_snapshot->>'stock_source_sha256'
    OR (applied.source_snapshot->'return_allocation_event_ids' @> jsonb_build_array(NEW.id::text)) IS DISTINCT FROM true
    OR NOT EXISTS(SELECT 1 FROM public.stock_valuation_entries target WHERE target.id=NEW.original_entry_id
      AND target.article_id=applied.article_id AND target.source_sequence<applied.source_sequence) THEN
    RAISE EXCEPTION 'Return allocation must match its committed valuation entry and earlier original' USING ERRCODE='23514';
  END IF;
  IF NEW.inverse_of_event_id IS NULL THEN
    IF NEW.quantity_delta<=0 OR applied.source_snapshot->>'original_movement_id' IS DISTINCT FROM NEW.original_movement_id::text
      OR applied.source_snapshot->>'original_entry_id' IS DISTINCT FROM NEW.original_entry_id::text THEN
      RAISE EXCEPTION 'Primary return allocation must target the exact original posting' USING ERRCODE='23514';
    END IF;
  ELSE
    SELECT * INTO inverse FROM public.stock_valuation_return_allocation_events WHERE id=NEW.inverse_of_event_id;
    IF NOT FOUND OR inverse.applied_entry_id::text IS DISTINCT FROM applied.source_snapshot->>'original_entry_id'
      OR(inverse.original_movement_id,inverse.original_entry_id,inverse.owner_key,inverse.stock_unit,inverse.currency)
        IS DISTINCT FROM(NEW.original_movement_id,NEW.original_entry_id,NEW.owner_key,NEW.stock_unit,NEW.currency)
      OR sign(inverse.quantity_delta)=sign(NEW.quantity_delta) THEN
      RAISE EXCEPTION 'Inverse return allocation requires the exact prior allocation event' USING ERRCODE='23514';
    END IF;
    SELECT * INTO original FROM public.stock_valuation_entries WHERE id=inverse.applied_entry_id;
    IF abs(inverse.quantity_delta) IS DISTINCT FROM abs(original.quantity_delta)
      OR abs(inverse.value_delta) IS DISTINCT FROM original.movement_value THEN
      RAISE EXCEPTION 'Original return allocation magnitudes do not match its valuation entry' USING ERRCODE='23514';
    END IF;
    IF NOT public.fn_stock_return_inverse_bounds_986(NEW.inverse_of_event_id) THEN
      RAISE EXCEPTION 'Return allocation event cannot be inverted beyond its original quantity or amount' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER stock_return_allocation_link_guard AFTER INSERT ON public.stock_valuation_return_allocation_events
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.fn_stock_return_allocation_link_guard_986();

CREATE FUNCTION public.fn_stock_return_cursor_guard_986() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'Return cursors require their immutable allocation history' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.stock_valuation_return_allocation_events e WHERE e.id=NEW.latest_event_id
    AND(e.original_movement_id,e.original_entry_id,e.owner_key,e.stock_unit,e.currency)
      IS NOT DISTINCT FROM(NEW.original_movement_id,NEW.original_entry_id,NEW.owner_key,NEW.stock_unit,NEW.currency)
    AND(e.source_snapshot->'after_cursor'->>'quantity')::numeric=NEW.quantity
    AND(e.source_snapshot->'after_cursor'->>'value')::numeric IS NOT DISTINCT FROM NEW.value) THEN
    RAISE EXCEPTION 'Return cursor must retain its immutable latest event' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND ((NEW.original_movement_id,NEW.original_entry_id,NEW.owner_key,NEW.stock_unit,NEW.currency)
    IS DISTINCT FROM(OLD.original_movement_id,OLD.original_entry_id,OLD.owner_key,OLD.stock_unit,OLD.currency)
    OR NOT EXISTS(SELECT 1 FROM public.stock_valuation_return_allocation_events e
      WHERE e.id=NEW.latest_event_id AND e.previous_event_id=OLD.latest_event_id)) THEN
    RAISE EXCEPTION 'Return cursor must extend its previous event without changing scope' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER stock_return_cursor_owner_guard BEFORE INSERT OR UPDATE OR DELETE
  ON public.stock_valuation_return_allocations FOR EACH ROW EXECUTE FUNCTION public.fn_stock_return_cursor_guard_986();
CREATE TRIGGER stock_return_cursor_truncate_guard BEFORE TRUNCATE
  ON public.stock_valuation_return_allocations FOR EACH STATEMENT EXECUTE FUNCTION public.fn_stock_return_cursor_guard_986();
ALTER TABLE public.stock_valuation_return_boundary OWNER TO cerp_app;
ALTER TABLE public.stock_valuation_return_sources OWNER TO cerp_app;
ALTER TABLE public.stock_valuation_return_allocation_events OWNER TO cerp_app;
ALTER FUNCTION public.fn_stock_return_source_guard_986() OWNER TO cerp_app;
ALTER FUNCTION public.fn_stock_return_source_capture_986() OWNER TO cerp_app;
ALTER FUNCTION public.fn_stock_return_allocation_guard_986() OWNER TO cerp_app;
ALTER FUNCTION public.fn_stock_return_inverse_bounds_986(uuid) OWNER TO cerp_app;
ALTER FUNCTION public.fn_stock_return_allocation_link_guard_986() OWNER TO cerp_app;
ALTER FUNCTION public.fn_stock_return_cursor_guard_986() OWNER TO cerp_app;
COMMIT;
