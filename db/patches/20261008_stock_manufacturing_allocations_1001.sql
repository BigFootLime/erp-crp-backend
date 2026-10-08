-- Net manufacturing allocation ledger. No backfill, physical write or activation.
BEGIN;
SET LOCAL lock_timeout='10s';
CREATE TABLE public.stock_valuation_manufacturing_allocation_events (
  id uuid PRIMARY KEY,
  basis_id uuid NOT NULL REFERENCES public.stock_valuation_manufacturing_bases(id) ON DELETE RESTRICT,
  applied_entry_id uuid NOT NULL UNIQUE REFERENCES public.stock_valuation_entries(id) DEFERRABLE INITIALLY DEFERRED,
  applied_movement_id uuid NOT NULL REFERENCES public.stock_valuation_movement_journal(movement_id) ON DELETE RESTRICT,
  article_id uuid NOT NULL REFERENCES public.articles(id) ON DELETE RESTRICT,
  owner_key text NOT NULL CHECK(owner_key='COMPANY'),
  stock_unit text NOT NULL CHECK(stock_unit='u'),
  currency text NOT NULL CHECK(currency='EUR'),
  previous_event_id uuid REFERENCES public.stock_valuation_manufacturing_allocation_events(id) ON DELETE RESTRICT,
  inverse_of_event_id uuid REFERENCES public.stock_valuation_manufacturing_allocation_events(id) ON DELETE RESTRICT,
  quantity_delta numeric(38,12) NOT NULL CHECK(quantity_delta<>0 AND quantity_delta<>'NaN'::numeric),
  value_delta numeric(38,12) NOT NULL CHECK(value_delta<>'NaN'::numeric),
  source_snapshot jsonb NOT NULL CHECK(jsonb_typeof(source_snapshot)='object'),
  source_sha256 text NOT NULL CHECK(source_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX stock_manufacturing_allocation_inverse_1001_idx
  ON public.stock_valuation_manufacturing_allocation_events(inverse_of_event_id) WHERE inverse_of_event_id IS NOT NULL;
CREATE TABLE public.stock_valuation_manufacturing_allocations (
  basis_id uuid PRIMARY KEY REFERENCES public.stock_valuation_manufacturing_bases(id) ON DELETE RESTRICT,
  article_id uuid NOT NULL REFERENCES public.articles(id) ON DELETE RESTRICT,
  owner_key text NOT NULL CHECK(owner_key='COMPANY'),
  stock_unit text NOT NULL CHECK(stock_unit='u'),
  currency text NOT NULL CHECK(currency='EUR'),
  quantity numeric(38,12) NOT NULL CHECK(quantity>=0 AND quantity<>'NaN'::numeric),
  value numeric(38,12) NOT NULL CHECK(value>=0 AND value<>'NaN'::numeric),
  latest_event_id uuid NOT NULL REFERENCES public.stock_valuation_manufacturing_allocation_events(id) ON DELETE RESTRICT
);

CREATE FUNCTION public.fn_stock_manufacturing_allocation_guard_1001() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE basis public.stock_valuation_manufacturing_bases%ROWTYPE;
  prior public.stock_valuation_manufacturing_allocations%ROWTYPE;
  inverse public.stock_valuation_manufacturing_allocation_events%ROWTYPE;
  before_qty numeric:=0; before_value numeric:=0; after_qty numeric; after_value numeric; previous_id uuid;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Manufacturing allocation events are immutable' USING ERRCODE='23514'; END IF;
  SELECT * INTO basis FROM public.stock_valuation_manufacturing_bases WHERE id=NEW.basis_id;
  IF NOT FOUND OR basis.source_sha256<>encode(digest(basis.source_snapshot::text,'sha256'),'hex')
    OR NEW.source_sha256<>encode(digest(NEW.source_snapshot::text,'sha256'),'hex')
    OR NEW.source_snapshot->>'basis_source_sha256' IS DISTINCT FROM basis.source_sha256
    OR NEW.source_snapshot->>'schema_version' IS DISTINCT FROM '1'
    OR NOT EXISTS(SELECT 1 FROM public.stock_valuation_projector_control WHERE singleton AND mode='ACTIVE' AND reporting_currency=NEW.currency)
    OR NOT EXISTS(SELECT 1 FROM public.stock_valuation_movement_journal j WHERE j.movement_id=NEW.applied_movement_id
      AND j.article_id=NEW.article_id AND j.source_sha256=NEW.source_snapshot->>'stock_source_sha256') THEN
    RAISE EXCEPTION 'Manufacturing allocation requires its declared base and immutable Stock source' USING ERRCODE='23514';
  END IF;
  SELECT * INTO prior FROM public.stock_valuation_manufacturing_allocations WHERE basis_id=NEW.basis_id;
  IF FOUND THEN
    IF (prior.article_id,prior.owner_key,prior.stock_unit,prior.currency) IS DISTINCT FROM(NEW.article_id,NEW.owner_key,NEW.stock_unit,NEW.currency) THEN
      RAISE EXCEPTION 'Manufacturing allocation scope changed' USING ERRCODE='23514';
    END IF;
    before_qty:=prior.quantity;before_value:=prior.value;previous_id:=prior.latest_event_id;
  END IF;
  IF NEW.previous_event_id IS DISTINCT FROM previous_id
    OR (NEW.source_snapshot#>>'{before_budget,quantity}')::numeric IS DISTINCT FROM basis.quantity_good
    OR (NEW.source_snapshot#>>'{before_budget,value}')::numeric IS DISTINCT FROM basis.total_cost_ht
    OR (NEW.source_snapshot#>>'{before_budget,allocatedQuantity}')::numeric IS DISTINCT FROM before_qty
    OR (NEW.source_snapshot#>>'{before_budget,allocatedValue}')::numeric IS DISTINCT FROM before_value THEN
    RAISE EXCEPTION 'Manufacturing allocation must extend its exact net budget' USING ERRCODE='23514';
  END IF;
  after_qty:=before_qty+NEW.quantity_delta;after_value:=before_value+NEW.value_delta;
  IF after_qty<0 OR after_qty>basis.quantity_good OR after_value<0 OR after_value>basis.total_cost_ht
    OR(NEW.quantity_delta>0 AND NEW.value_delta<0) OR(NEW.quantity_delta<0 AND NEW.value_delta>0)
    OR(after_qty=0 AND after_value<>0) OR(after_qty=basis.quantity_good AND after_value<>basis.total_cost_ht)
    OR(NEW.source_snapshot#>>'{after_budget,quantity}')::numeric IS DISTINCT FROM basis.quantity_good
    OR(NEW.source_snapshot#>>'{after_budget,value}')::numeric IS DISTINCT FROM basis.total_cost_ht
    OR(NEW.source_snapshot#>>'{after_budget,allocatedQuantity}')::numeric IS DISTINCT FROM after_qty
    OR(NEW.source_snapshot#>>'{after_budget,allocatedValue}')::numeric IS DISTINCT FROM after_value THEN
    RAISE EXCEPTION 'Manufacturing allocation exceeds its exact total quantity or value' USING ERRCODE='23514';
  END IF;
  IF NEW.inverse_of_event_id IS NULL THEN
    IF NEW.quantity_delta<=0 THEN RAISE EXCEPTION 'A manufacturing receipt allocates positive quantity' USING ERRCODE='23514'; END IF;
    IF NEW.value_delta IS DISTINCT FROM (CASE WHEN NEW.quantity_delta=basis.quantity_good-before_qty
      THEN basis.total_cost_ht-before_value
      ELSE round((basis.total_cost_ht-before_value)*NEW.quantity_delta/(basis.quantity_good-before_qty),12) END) THEN
      RAISE EXCEPTION 'Manufacturing receipt must allocate its exact remaining value' USING ERRCODE='23514';
    END IF;
  ELSE
    SELECT * INTO inverse FROM public.stock_valuation_manufacturing_allocation_events WHERE id=NEW.inverse_of_event_id;
    IF NOT FOUND OR(inverse.basis_id,inverse.article_id,inverse.owner_key,inverse.stock_unit,inverse.currency)
      IS DISTINCT FROM(NEW.basis_id,NEW.article_id,NEW.owner_key,NEW.stock_unit,NEW.currency)
      OR sign(inverse.quantity_delta)=sign(NEW.quantity_delta)
      OR inverse.applied_entry_id::text IS DISTINCT FROM NEW.source_snapshot->>'original_entry_id' THEN
      RAISE EXCEPTION 'Manufacturing inverse requires its exact parent allocation' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER stock_manufacturing_allocation_immutable BEFORE INSERT OR UPDATE OR DELETE
  ON public.stock_valuation_manufacturing_allocation_events FOR EACH ROW EXECUTE FUNCTION public.fn_stock_manufacturing_allocation_guard_1001();
CREATE TRIGGER stock_manufacturing_allocation_truncate_guard BEFORE TRUNCATE
  ON public.stock_valuation_manufacturing_allocation_events FOR EACH STATEMENT EXECUTE FUNCTION public.fn_stock_manufacturing_allocation_guard_1001();

-- Bounds include all descendants: cancelling a cancellation restores the net
-- capacity of its ancestors, rather than accumulating gross cancelled totals.
CREATE FUNCTION public.fn_stock_manufacturing_inverse_bounds_1001(event_id uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  WITH RECURSIVE ancestors AS (
    SELECT id,inverse_of_event_id,0 AS depth FROM public.stock_valuation_manufacturing_allocation_events WHERE id=event_id
    UNION ALL
    SELECT e.id,e.inverse_of_event_id,a.depth+1 FROM ancestors a
      JOIN public.stock_valuation_manufacturing_allocation_events e ON e.id=a.inverse_of_event_id WHERE a.depth<65
  ), effects AS (
    SELECT a.id AS root,e.id,e.quantity_delta,e.value_delta,1 AS depth FROM ancestors a
      JOIN public.stock_valuation_manufacturing_allocation_events e ON e.inverse_of_event_id=a.id
    UNION ALL
    SELECT p.root,e.id,e.quantity_delta,e.value_delta,p.depth+1 FROM effects p
      JOIN public.stock_valuation_manufacturing_allocation_events e ON e.inverse_of_event_id=p.id WHERE p.depth<65
  ), totals AS (
    SELECT r.id,r.quantity_delta,r.value_delta,
      -sign(r.quantity_delta)*COALESCE(sum(e.quantity_delta),0) AS inverted_quantity,
      -sign(r.quantity_delta)*COALESCE(sum(e.value_delta),0) AS inverted_value
    FROM ancestors a JOIN public.stock_valuation_manufacturing_allocation_events r ON r.id=a.id
      LEFT JOIN effects e ON e.root=r.id GROUP BY r.id,r.quantity_delta,r.value_delta
  ) SELECT EXISTS(SELECT 1 FROM ancestors)
    AND NOT EXISTS(SELECT 1 FROM ancestors WHERE depth=65)
    AND NOT EXISTS(SELECT 1 FROM effects WHERE depth=65)
    AND NOT EXISTS(SELECT 1 FROM totals WHERE inverted_quantity<0 OR inverted_quantity>abs(quantity_delta)
      OR inverted_value<0 OR inverted_value>abs(value_delta)
      OR(inverted_quantity=0 AND inverted_value<>0)
      OR(inverted_quantity=abs(quantity_delta) AND inverted_value<>abs(value_delta)))
$$;

CREATE FUNCTION public.fn_stock_manufacturing_allocation_link_guard_1001() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE applied public.stock_valuation_entries%ROWTYPE; basis public.stock_valuation_manufacturing_bases%ROWTYPE;
  inverse public.stock_valuation_manufacturing_allocation_events%ROWTYPE;
  root public.stock_valuation_movement_journal%ROWTYPE; manufacturing public.stock_valuation_manufacturing_sources%ROWTYPE;
BEGIN
  SELECT * INTO applied FROM public.stock_valuation_entries WHERE id=NEW.applied_entry_id;
  IF NOT FOUND OR applied.movement_id<>NEW.applied_movement_id OR applied.article_id<>NEW.article_id
    OR(applied.owner_key,applied.stock_unit,applied.currency) IS DISTINCT FROM(NEW.owner_key,NEW.stock_unit,NEW.currency)
    OR applied.reliability<>'DECLARED' OR applied.quantity_delta IS DISTINCT FROM NEW.quantity_delta
    OR applied.movement_value IS DISTINCT FROM abs(NEW.value_delta)
    OR applied.source_snapshot->>'manufacturing_allocation_event_id' IS DISTINCT FROM NEW.id::text
    OR applied.source_snapshot->>'manufacturing_basis_id' IS DISTINCT FROM NEW.basis_id::text
    OR applied.source_snapshot->>'stock_source_sha256' IS DISTINCT FROM NEW.source_snapshot->>'stock_source_sha256' THEN
    RAISE EXCEPTION 'Manufacturing allocation must match its committed CUMP entry' USING ERRCODE='23514';
  END IF;
  SELECT * INTO root FROM public.stock_valuation_movement_journal WHERE movement_id=NEW.applied_movement_id;
  SELECT * INTO basis FROM public.stock_valuation_manufacturing_bases WHERE id=NEW.basis_id;
  IF NEW.inverse_of_event_id IS NULL THEN
    SELECT * INTO manufacturing FROM public.stock_valuation_manufacturing_sources WHERE movement_id=NEW.applied_movement_id;
    IF NOT FOUND OR applied.kind<>'RECEIPT' OR root.source_snapshot->>'source_document_type' IS DISTINCT FROM 'OF'
      OR root.source_snapshot->>'movement_type' IS DISTINCT FROM 'IN'
      OR root.source_snapshot->>'reversal_of_id' IS NOT NULL
      OR root.source_snapshot->>'source_document_id' IS DISTINCT FROM basis.of_id::text
      OR manufacturing.source_sha256<>encode(digest(manufacturing.source_snapshot::text,'sha256'),'hex')
      OR manufacturing.source_snapshot->>'stock_source_sha256' IS DISTINCT FROM root.source_sha256
      OR NEW.source_snapshot->>'manufacturing_source_sha256' IS DISTINCT FROM manufacturing.source_sha256
      OR jsonb_array_length(manufacturing.source_snapshot->'receipts') IS DISTINCT FROM 1
      OR manufacturing.source_snapshot#>>'{receipts,0,of_id}' IS DISTINCT FROM basis.of_id::text
      OR manufacturing.source_snapshot#>>'{receipts,0,of,piece_technique_id}' IS DISTINCT FROM basis.source_snapshot#>>'{of,piece_technique_id}'
      OR manufacturing.source_snapshot#>>'{receipts,0,of,piece_technique_version_id}' IS DISTINCT FROM basis.source_snapshot#>>'{of,piece_technique_version_id}'
      OR(manufacturing.source_snapshot#>>'{receipts,0,quantity_good}')::numeric IS DISTINCT FROM NEW.quantity_delta THEN
      RAISE EXCEPTION 'Manufacturing allocation requires its frozen OF receipt and technical version' USING ERRCODE='23514';
    END IF;
  ELSE
    SELECT * INTO inverse FROM public.stock_valuation_manufacturing_allocation_events WHERE id=NEW.inverse_of_event_id;
    IF NOT FOUND OR applied.kind NOT IN('RETURN','RECEIPT_REVERSAL')
      OR (CASE WHEN NEW.quantity_delta>0 THEN 'RETURN' ELSE 'RECEIPT_REVERSAL' END)<>applied.kind
      OR applied.source_snapshot->>'original_entry_id' IS DISTINCT FROM inverse.applied_entry_id::text
      OR root.source_snapshot->>'reversal_of_id' IS DISTINCT FROM inverse.applied_movement_id::text
      OR NOT EXISTS(SELECT 1 FROM public.stock_valuation_entries parent WHERE parent.id=inverse.applied_entry_id
        AND parent.source_sequence<applied.source_sequence AND parent.article_id=applied.article_id)
      OR NOT public.fn_stock_manufacturing_inverse_bounds_1001(NEW.inverse_of_event_id) THEN
      RAISE EXCEPTION 'Manufacturing inverse must retain its earlier parent and net quantity/value bounds' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER stock_manufacturing_allocation_link_guard AFTER INSERT
  ON public.stock_valuation_manufacturing_allocation_events DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.fn_stock_manufacturing_allocation_link_guard_1001();

CREATE FUNCTION public.fn_stock_manufacturing_cursor_guard_1001() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'Manufacturing cursors require their immutable history' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.stock_valuation_manufacturing_allocation_events e WHERE e.id=NEW.latest_event_id
    AND(e.basis_id,e.article_id,e.owner_key,e.stock_unit,e.currency)
      IS NOT DISTINCT FROM(NEW.basis_id,NEW.article_id,NEW.owner_key,NEW.stock_unit,NEW.currency)
    AND(e.source_snapshot#>>'{after_budget,allocatedQuantity}')::numeric=NEW.quantity
    AND(e.source_snapshot#>>'{after_budget,allocatedValue}')::numeric=NEW.value) THEN
    RAISE EXCEPTION 'Manufacturing cursor must retain its immutable latest event' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND ((NEW.basis_id,NEW.article_id,NEW.owner_key,NEW.stock_unit,NEW.currency)
    IS DISTINCT FROM(OLD.basis_id,OLD.article_id,OLD.owner_key,OLD.stock_unit,OLD.currency)
    OR NOT EXISTS(SELECT 1 FROM public.stock_valuation_manufacturing_allocation_events e
      WHERE e.id=NEW.latest_event_id AND e.previous_event_id=OLD.latest_event_id)) THEN
    RAISE EXCEPTION 'Manufacturing cursor must extend its exact prior event' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER stock_manufacturing_cursor_owner_guard BEFORE INSERT OR UPDATE OR DELETE
  ON public.stock_valuation_manufacturing_allocations FOR EACH ROW EXECUTE FUNCTION public.fn_stock_manufacturing_cursor_guard_1001();
CREATE TRIGGER stock_manufacturing_cursor_truncate_guard BEFORE TRUNCATE
  ON public.stock_valuation_manufacturing_allocations FOR EACH STATEMENT EXECUTE FUNCTION public.fn_stock_manufacturing_cursor_guard_1001();
ALTER TABLE public.stock_valuation_manufacturing_allocation_events OWNER TO cerp_app;
ALTER TABLE public.stock_valuation_manufacturing_allocations OWNER TO cerp_app;
ALTER FUNCTION public.fn_stock_manufacturing_allocation_guard_1001() OWNER TO cerp_app;
ALTER FUNCTION public.fn_stock_manufacturing_inverse_bounds_1001(uuid) OWNER TO cerp_app;
ALTER FUNCTION public.fn_stock_manufacturing_allocation_link_guard_1001() OWNER TO cerp_app;
ALTER FUNCTION public.fn_stock_manufacturing_cursor_guard_1001() OWNER TO cerp_app;
COMMIT;
