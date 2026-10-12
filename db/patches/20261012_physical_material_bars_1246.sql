-- #1246. Physical geometry supplements the canonical stock ledger. No backfill:
-- aggregate millimetres cannot prove how many real bars or remnants exist.
BEGIN;
CREATE INDEX IF NOT EXISTS stock_material_bar_movements_1246_idx
  ON public.stock_movements(stock_batch_id) WHERE status='POSTED';
CREATE TABLE IF NOT EXISTS public.stock_material_bar_inventories (
  stock_batch_id uuid PRIMARY KEY REFERENCES public.stock_batches(id) ON DELETE RESTRICT,
  movement_count bigint NOT NULL CHECK (movement_count >= 0),
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version > 0),
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  confirmed_by integer NOT NULL REFERENCES public.users(id),
  note text NOT NULL CHECK (length(trim(note)) >= 3)
);
CREATE TABLE IF NOT EXISTS public.stock_material_bars (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stock_batch_id uuid NOT NULL REFERENCES public.stock_material_bar_inventories(stock_batch_id) ON DELETE RESTRICT,
  initial_length_mm numeric(14,3) NOT NULL CHECK (initial_length_mm > 0 AND initial_length_mm <= 1000000000),
  remaining_length_mm numeric(14,3) NOT NULL CHECK (remaining_length_mm >= 0 AND remaining_length_mm <= initial_length_mm),
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version > 0),
  retired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by integer NOT NULL REFERENCES public.users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by integer NOT NULL REFERENCES public.users(id)
);
CREATE INDEX IF NOT EXISTS stock_material_bars_batch_1246_idx
  ON public.stock_material_bars(stock_batch_id, created_at, id) WHERE retired_at IS NULL;
CREATE TABLE IF NOT EXISTS public.stock_material_bar_reservations (
  bar_id uuid NOT NULL REFERENCES public.stock_material_bars(id) ON DELETE RESTRICT,
  reservation_id uuid NOT NULL REFERENCES public.stock_reservations(id) ON DELETE RESTRICT,
  remaining_length_mm numeric(14,3) NOT NULL CHECK (remaining_length_mm >= 0 AND remaining_length_mm <= 1000000000),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by integer NOT NULL REFERENCES public.users(id),
  PRIMARY KEY (bar_id, reservation_id)
);
CREATE INDEX IF NOT EXISTS stock_material_bar_reservations_1246_idx
  ON public.stock_material_bar_reservations(reservation_id);
CREATE TABLE IF NOT EXISTS public.stock_material_bar_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bar_id uuid NOT NULL REFERENCES public.stock_material_bars(id) ON DELETE RESTRICT,
  command_key uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('INITIALIZE','RECONCILE','RESERVE','RELEASE','CUT','COMPENSATE','MOVE')),
  stock_movement_id uuid REFERENCES public.stock_movements(id) ON DELETE RESTRICT,
  before_state jsonb,
  after_state jsonb NOT NULL,
  reason text NOT NULL CHECK (length(trim(reason)) >= 3),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by integer NOT NULL REFERENCES public.users(id),
  UNIQUE (bar_id, command_key, action),
  CHECK (action NOT IN ('CUT','COMPENSATE','MOVE') OR stock_movement_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS stock_material_bar_event_command_1246_idx ON public.stock_material_bar_events(command_key,action);
CREATE OR REPLACE FUNCTION public.protect_material_bar_event_1246() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Physical bar events are immutable; record a linked correction' USING ERRCODE='23514';
END $$;
DROP TRIGGER IF EXISTS stock_material_bar_events_1246_immutable ON public.stock_material_bar_events;
CREATE TRIGGER stock_material_bar_events_1246_immutable BEFORE UPDATE OR DELETE ON public.stock_material_bar_events
  FOR EACH ROW EXECUTE FUNCTION public.protect_material_bar_event_1246();

-- Reassignments are explicit releases and allocations, not identity rewrites.
-- Otherwise a deferred check on NEW alone could leave the old reservation short.
CREATE OR REPLACE FUNCTION public.protect_material_bar_identity_1246() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='stock_material_bars' THEN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.stock_batch_id IS DISTINCT FROM OLD.stock_batch_id
      OR NEW.initial_length_mm IS DISTINCT FROM OLD.initial_length_mm THEN
      RAISE EXCEPTION 'Physical bar identity is immutable; record a reconciliation or movement' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.bar_id IS DISTINCT FROM OLD.bar_id OR NEW.reservation_id IS DISTINCT FROM OLD.reservation_id THEN
    RAISE EXCEPTION 'Physical bar hold identity is immutable; release and allocate explicitly' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS stock_material_bar_identity_1246 ON public.stock_material_bars;
CREATE TRIGGER stock_material_bar_identity_1246 BEFORE UPDATE ON public.stock_material_bars
  FOR EACH ROW EXECUTE FUNCTION public.protect_material_bar_identity_1246();
DROP TRIGGER IF EXISTS stock_material_bar_hold_identity_1246 ON public.stock_material_bar_reservations;
CREATE TRIGGER stock_material_bar_hold_identity_1246 BEFORE UPDATE ON public.stock_material_bar_reservations
  FOR EACH ROW EXECUTE FUNCTION public.protect_material_bar_identity_1246();

-- Cross-row capacity is checked at commit so one canonical debit can update
-- stock, the reservation and the bar atomically without an intermediate error.
CREATE OR REPLACE FUNCTION public.check_material_bar_hold_1246() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE affected uuid; bar record; held numeric;
BEGIN
  IF TG_TABLE_NAME='stock_material_bars' THEN affected := NEW.id;
  ELSIF TG_OP='DELETE' THEN affected := OLD.bar_id;
  ELSE affected := NEW.bar_id;
  END IF;
  SELECT * INTO bar FROM public.stock_material_bars WHERE id=affected FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT COALESCE(sum(remaining_length_mm),0) INTO held FROM public.stock_material_bar_reservations WHERE bar_id=affected;
  IF held>bar.remaining_length_mm OR (bar.retired_at IS NOT NULL AND held<>0) THEN
    RAISE EXCEPTION 'Physical bar reservations exceed its remaining length' USING ERRCODE='23514';
  END IF;
  IF EXISTS (SELECT 1 FROM public.stock_material_bar_reservations h
    JOIN public.stock_reservations r ON r.id=h.reservation_id
    WHERE h.bar_id=affected AND h.remaining_length_mm>0 AND r.stock_batch_id IS DISTINCT FROM bar.stock_batch_id) THEN
    RAISE EXCEPTION 'Physical bar reservation belongs to another stock batch' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION public.check_material_bar_reservation_1246() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE affected uuid; reserved record; held numeric;
BEGIN
  IF TG_TABLE_NAME='stock_reservations' THEN
    affected := NEW.id;
    IF NOT EXISTS (SELECT 1 FROM public.stock_material_bar_reservations WHERE reservation_id=affected) THEN RETURN NULL; END IF;
  ELSIF TG_OP='DELETE' THEN affected := OLD.reservation_id;
  ELSE affected := NEW.reservation_id;
  END IF;
  SELECT * INTO reserved FROM public.stock_reservations WHERE id=affected FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT COALESCE(sum(remaining_length_mm),0) INTO held FROM public.stock_material_bar_reservations WHERE reservation_id=affected;
  IF held <> (CASE WHEN reserved.status='ACTIVE' THEN GREATEST(0,reserved.qty_reserved-reserved.qty_consumed) ELSE 0 END) THEN
    RAISE EXCEPTION 'Physical bar allocations must match the canonical reservation' USING ERRCODE='23514';
  END IF;
  IF EXISTS (SELECT 1 FROM public.stock_material_bar_reservations h
    JOIN public.stock_material_bars b ON b.id=h.bar_id
    WHERE h.reservation_id=affected AND h.remaining_length_mm>0 AND b.stock_batch_id IS DISTINCT FROM reserved.stock_batch_id) THEN
    RAISE EXCEPTION 'Physical bar reservation belongs to another stock batch' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS stock_material_bar_capacity_1246 ON public.stock_material_bars;
CREATE CONSTRAINT TRIGGER stock_material_bar_capacity_1246 AFTER INSERT OR UPDATE ON public.stock_material_bars
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_material_bar_hold_1246();
DROP TRIGGER IF EXISTS stock_material_bar_hold_capacity_1246 ON public.stock_material_bar_reservations;
CREATE CONSTRAINT TRIGGER stock_material_bar_hold_capacity_1246 AFTER INSERT OR UPDATE OR DELETE ON public.stock_material_bar_reservations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_material_bar_hold_1246();
DROP TRIGGER IF EXISTS stock_material_bar_hold_total_1246 ON public.stock_material_bar_reservations;
CREATE CONSTRAINT TRIGGER stock_material_bar_hold_total_1246 AFTER INSERT OR UPDATE OR DELETE ON public.stock_material_bar_reservations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_material_bar_reservation_1246();
DROP TRIGGER IF EXISTS stock_material_bar_reservation_total_1246 ON public.stock_reservations;
CREATE CONSTRAINT TRIGGER stock_material_bar_reservation_total_1246 AFTER INSERT OR UPDATE ON public.stock_reservations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_material_bar_reservation_1246();

ALTER TABLE public.stock_material_bar_inventories OWNER TO cerp_app;
ALTER TABLE public.stock_material_bars OWNER TO cerp_app;
ALTER TABLE public.stock_material_bar_reservations OWNER TO cerp_app;
ALTER TABLE public.stock_material_bar_events OWNER TO cerp_app;
ALTER FUNCTION public.protect_material_bar_event_1246() OWNER TO cerp_app;
ALTER FUNCTION public.protect_material_bar_identity_1246() OWNER TO cerp_app;
ALTER FUNCTION public.check_material_bar_hold_1246() OWNER TO cerp_app;
ALTER FUNCTION public.check_material_bar_reservation_1246() OWNER TO cerp_app;
COMMIT;
