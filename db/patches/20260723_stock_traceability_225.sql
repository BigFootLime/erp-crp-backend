-- Issue #225 - Stock, lots, movements, reservations and inventories.
-- Additive/idempotent patch. Validate on cerp_test before any production proposal.
-- No industrial evidence is deleted or rewritten by this patch.

BEGIN;

DO $$
DECLARE
  required_table text;
BEGIN
  FOREACH required_table IN ARRAY ARRAY[
    'articles',
    'users',
    'units',
    'warehouses',
    'locations',
    'magasins',
    'emplacements',
    'lots',
    'stock_levels',
    'stock_batches',
    'stock_movements',
    'stock_movement_lines',
    'stock_movement_event_log',
    'stock_reservations',
    'commande_ligne',
    'ordres_fabrication',
    'bon_livraison_ligne',
    'affaire',
    'stock_inventory_sessions',
    'stock_inventory_lines',
    'stock_inventory_session_movements'
  ]
  LOOP
    IF to_regclass(format('public.%I', required_table)) IS NULL THEN
      RAISE EXCEPTION '#225 prerequisite missing: public.%', required_table;
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'stock_movements'
      AND column_name = 'id'
      AND data_type = 'uuid'
  ) THEN
    RAISE EXCEPTION '#225 requires the canonical UUID stock movement spine';
  END IF;
END $$;

/* -------------------------------------------------------------------------- */
/* Physical topology                                                          */
/* -------------------------------------------------------------------------- */

ALTER TABLE public.emplacements
  ADD COLUMN IF NOT EXISTS location_type text NOT NULL DEFAULT 'STORAGE',
  ADD COLUMN IF NOT EXISTS allow_inbound boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS allow_outbound boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS restrictions jsonb NOT NULL DEFAULT '{}'::jsonb;

UPDATE public.emplacements
SET
  location_type = 'SCRAP',
  allow_outbound = false
WHERE is_scrap = true
  AND location_type = 'STORAGE';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'emplacements_location_type_ck'
      AND conrelid = 'public.emplacements'::regclass
  ) THEN
    ALTER TABLE public.emplacements
      ADD CONSTRAINT emplacements_location_type_ck
      CHECK (location_type IN (
        'RECEIVING',
        'PRODUCTION',
        'QUARANTINE',
        'SCRAP',
        'SHIPPING',
        'STORAGE'
      ));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'emplacements_restrictions_object_ck'
      AND conrelid = 'public.emplacements'::regclass
  ) THEN
    ALTER TABLE public.emplacements
      ADD CONSTRAINT emplacements_restrictions_object_ck
      CHECK (jsonb_typeof(restrictions) = 'object');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS emplacements_location_type_idx
  ON public.emplacements(location_type, is_active);

/* -------------------------------------------------------------------------- */
/* Immutable movement correlation and generic command idempotence             */
/* -------------------------------------------------------------------------- */

ALTER TABLE public.stock_movements
  ADD COLUMN IF NOT EXISTS correlation_id uuid NULL,
  ADD COLUMN IF NOT EXISTS reversal_of_id uuid NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stock_movements_reversal_of_id_fkey'
      AND conrelid = 'public.stock_movements'::regclass
  ) THEN
    ALTER TABLE public.stock_movements
      ADD CONSTRAINT stock_movements_reversal_of_id_fkey
      FOREIGN KEY (reversal_of_id) REFERENCES public.stock_movements(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stock_movements_not_self_reversal_ck'
      AND conrelid = 'public.stock_movements'::regclass
  ) THEN
    ALTER TABLE public.stock_movements
      ADD CONSTRAINT stock_movements_not_self_reversal_ck
      CHECK (reversal_of_id IS NULL OR reversal_of_id <> id);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS stock_movements_reversal_once_uq
  ON public.stock_movements(reversal_of_id)
  WHERE reversal_of_id IS NOT NULL
    AND status::text <> 'CANCELLED';
CREATE INDEX IF NOT EXISTS stock_movements_correlation_idx
  ON public.stock_movements(correlation_id)
  WHERE correlation_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.stock_command_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  command_type text NOT NULL,
  resource_type text NOT NULL,
  resource_id text NOT NULL,
  request_payload jsonb NOT NULL,
  result_payload jsonb NOT NULL,
  correlation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stock_command_receipts_actor_key_uq UNIQUE (actor_user_id, idempotency_key),
  CONSTRAINT stock_command_receipts_key_len_ck CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
  CONSTRAINT stock_command_receipts_request_hash_ck CHECK (request_hash ~ '^[A-Fa-f0-9]{64}$'),
  CONSTRAINT stock_command_receipts_command_type_ck CHECK (command_type IN (
    'MOVEMENT_CREATE',
    'MOVEMENT_POST',
    'MOVEMENT_CANCEL',
    'MOVEMENT_COMPENSATE',
    'RESERVATION_CREATE',
    'RESERVATION_RELEASE',
    'RESERVATION_CONSUME',
    'LOT_QUALITY_CHANGE',
    'LOT_GENEALOGY_RECORD',
    'INVENTORY_CREATE',
    'INVENTORY_START',
    'INVENTORY_COUNT',
    'INVENTORY_APPROVE',
    'INVENTORY_CANCEL',
    'INVENTORY_CLOSE'
  ))
);

CREATE INDEX IF NOT EXISTS stock_command_receipts_resource_idx
  ON public.stock_command_receipts(resource_type, resource_id, created_at DESC);
CREATE INDEX IF NOT EXISTS stock_command_receipts_correlation_idx
  ON public.stock_command_receipts(correlation_id);

CREATE OR REPLACE FUNCTION public.fn_protect_stock_immutable_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'stock audit evidence is immutable'
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_stock_command_receipt ON public.stock_command_receipts;
CREATE TRIGGER trg_protect_stock_command_receipt
BEFORE UPDATE OR DELETE ON public.stock_command_receipts
FOR EACH ROW EXECUTE FUNCTION public.fn_protect_stock_immutable_evidence();

CREATE OR REPLACE FUNCTION public.fn_protect_posted_stock_movement()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'stock movements cannot be deleted'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.status::text IN ('POSTED', 'CANCELLED') THEN
    RAISE EXCEPTION 'posted or cancelled stock movements are immutable'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_posted_stock_movement ON public.stock_movements;
CREATE TRIGGER trg_protect_posted_stock_movement
BEFORE UPDATE OR DELETE ON public.stock_movements
FOR EACH ROW EXECUTE FUNCTION public.fn_protect_posted_stock_movement();

CREATE OR REPLACE FUNCTION public.fn_protect_posted_stock_movement_line()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  movement_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT status::text INTO movement_status
    FROM public.stock_movements
    WHERE id = OLD.movement_id;
  ELSE
    SELECT status::text INTO movement_status
    FROM public.stock_movements
    WHERE id = NEW.movement_id;
  END IF;

  IF movement_status IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'lines of a posted or cancelled stock movement are immutable'
      USING ERRCODE = '55000';
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_posted_stock_movement_line ON public.stock_movement_lines;
CREATE TRIGGER trg_protect_posted_stock_movement_line
BEFORE UPDATE OR DELETE ON public.stock_movement_lines
FOR EACH ROW EXECUTE FUNCTION public.fn_protect_posted_stock_movement_line();

DROP TRIGGER IF EXISTS trg_protect_stock_movement_event ON public.stock_movement_event_log;
CREATE TRIGGER trg_protect_stock_movement_event
BEFORE UPDATE OR DELETE ON public.stock_movement_event_log
FOR EACH ROW EXECUTE FUNCTION public.fn_protect_stock_immutable_evidence();

/* -------------------------------------------------------------------------- */
/* Reservation lifecycle                                                      */
/* -------------------------------------------------------------------------- */

ALTER TABLE public.stock_reservations
  ADD COLUMN IF NOT EXISTS correlation_id uuid NULL,
  ADD COLUMN IF NOT EXISTS commande_ligne_id bigint NULL,
  ADD COLUMN IF NOT EXISTS of_id bigint NULL,
  ADD COLUMN IF NOT EXISTS bon_livraison_ligne_id uuid NULL,
  ADD COLUMN IF NOT EXISTS affaire_id bigint NULL,
  ADD COLUMN IF NOT EXISTS reason text NULL,
  ADD COLUMN IF NOT EXISTS expires_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS released_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS released_by integer NULL,
  ADD COLUMN IF NOT EXISTS consumed_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS consumed_by integer NULL,
  ADD COLUMN IF NOT EXISTS consumed_stock_movement_id uuid NULL,
  ADD COLUMN IF NOT EXISTS row_version integer NOT NULL DEFAULT 1;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stock_reservations_consumed_movement_fkey'
      AND conrelid = 'public.stock_reservations'::regclass
  ) THEN
    ALTER TABLE public.stock_reservations
      ADD CONSTRAINT stock_reservations_consumed_movement_fkey
      FOREIGN KEY (consumed_stock_movement_id) REFERENCES public.stock_movements(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stock_reservations_commande_ligne_fkey'
      AND conrelid = 'public.stock_reservations'::regclass
  ) THEN
    ALTER TABLE public.stock_reservations
      ADD CONSTRAINT stock_reservations_commande_ligne_fkey
      FOREIGN KEY (commande_ligne_id) REFERENCES public.commande_ligne(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stock_reservations_of_fkey'
      AND conrelid = 'public.stock_reservations'::regclass
  ) THEN
    ALTER TABLE public.stock_reservations
      ADD CONSTRAINT stock_reservations_of_fkey
      FOREIGN KEY (of_id) REFERENCES public.ordres_fabrication(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stock_reservations_bon_livraison_ligne_fkey'
      AND conrelid = 'public.stock_reservations'::regclass
  ) THEN
    ALTER TABLE public.stock_reservations
      ADD CONSTRAINT stock_reservations_bon_livraison_ligne_fkey
      FOREIGN KEY (bon_livraison_ligne_id) REFERENCES public.bon_livraison_ligne(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stock_reservations_affaire_fkey'
      AND conrelid = 'public.stock_reservations'::regclass
  ) THEN
    ALTER TABLE public.stock_reservations
      ADD CONSTRAINT stock_reservations_affaire_fkey
      FOREIGN KEY (affaire_id) REFERENCES public.affaire(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stock_reservations_released_by_fkey'
      AND conrelid = 'public.stock_reservations'::regclass
  ) THEN
    ALTER TABLE public.stock_reservations
      ADD CONSTRAINT stock_reservations_released_by_fkey
      FOREIGN KEY (released_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stock_reservations_consumed_by_fkey'
      AND conrelid = 'public.stock_reservations'::regclass
  ) THEN
    ALTER TABLE public.stock_reservations
      ADD CONSTRAINT stock_reservations_consumed_by_fkey
      FOREIGN KEY (consumed_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stock_reservations_status_225_ck'
      AND conrelid = 'public.stock_reservations'::regclass
  ) THEN
    ALTER TABLE public.stock_reservations
      ADD CONSTRAINT stock_reservations_status_225_ck
      CHECK (status IN ('ACTIVE', 'RELEASED', 'CONSUMED', 'EXPIRED', 'CANCELLED')) NOT VALID;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS stock_reservations_expiry_idx
  ON public.stock_reservations(expires_at)
  WHERE status = 'ACTIVE' AND expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS stock_reservations_correlation_idx
  ON public.stock_reservations(correlation_id)
  WHERE correlation_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.stock_reservation_event_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id uuid NOT NULL REFERENCES public.stock_reservations(id) ON DELETE RESTRICT,
  event_type text NOT NULL,
  old_values jsonb NULL,
  new_values jsonb NULL,
  actor_user_id integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  correlation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stock_reservation_event_type_ck CHECK (event_type IN (
    'CREATED',
    'UPDATED',
    'RELEASED',
    'CONSUMED',
    'EXPIRED',
    'COMPENSATED'
  ))
);

CREATE INDEX IF NOT EXISTS stock_reservation_event_reservation_idx
  ON public.stock_reservation_event_log(reservation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS stock_reservation_event_correlation_idx
  ON public.stock_reservation_event_log(correlation_id);

DROP TRIGGER IF EXISTS trg_protect_stock_reservation_event ON public.stock_reservation_event_log;
CREATE TRIGGER trg_protect_stock_reservation_event
BEFORE UPDATE OR DELETE ON public.stock_reservation_event_log
FOR EACH ROW EXECUTE FUNCTION public.fn_protect_stock_immutable_evidence();

CREATE OR REPLACE FUNCTION public.fn_prepare_stock_reservation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.correlation_id := COALESCE(NEW.correlation_id, gen_random_uuid());
    NEW.row_version := 1;
  ELSE
    IF OLD.status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'inactive stock reservations are immutable'
        USING ERRCODE = '55000';
    END IF;
    NEW.correlation_id := COALESCE(NEW.correlation_id, OLD.correlation_id, gen_random_uuid());
    NEW.row_version := OLD.row_version + 1;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_log_stock_reservation_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  actor_id integer;
  emitted_event text;
BEGIN
  actor_id := COALESCE(NEW.updated_by, NEW.created_by);
  IF actor_id IS NULL THEN
    RAISE EXCEPTION 'stock reservation evidence requires an actor'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT' THEN
    emitted_event := 'CREATED';
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    emitted_event := CASE NEW.status
      WHEN 'RELEASED' THEN 'RELEASED'
      WHEN 'CONSUMED' THEN 'CONSUMED'
      WHEN 'EXPIRED' THEN 'EXPIRED'
      WHEN 'CANCELLED' THEN 'COMPENSATED'
      ELSE 'UPDATED'
    END;
  ELSE
    emitted_event := 'UPDATED';
  END IF;

  INSERT INTO public.stock_reservation_event_log (
    reservation_id,
    event_type,
    old_values,
    new_values,
    actor_user_id,
    correlation_id
  )
  VALUES (
    NEW.id,
    emitted_event,
    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END,
    to_jsonb(NEW),
    actor_id,
    NEW.correlation_id
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_prepare_stock_reservation ON public.stock_reservations;
CREATE TRIGGER trg_prepare_stock_reservation
BEFORE INSERT OR UPDATE ON public.stock_reservations
FOR EACH ROW EXECUTE FUNCTION public.fn_prepare_stock_reservation();

DROP TRIGGER IF EXISTS trg_log_stock_reservation_event ON public.stock_reservations;
CREATE TRIGGER trg_log_stock_reservation_event
AFTER INSERT OR UPDATE ON public.stock_reservations
FOR EACH ROW EXECUTE FUNCTION public.fn_log_stock_reservation_event();

/* -------------------------------------------------------------------------- */
/* Lot quality history and genealogy                                          */
/* -------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS public.stock_lot_event_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lot_id uuid NOT NULL REFERENCES public.lots(id) ON DELETE RESTRICT,
  event_type text NOT NULL,
  old_values jsonb NULL,
  new_values jsonb NULL,
  actor_user_id integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  correlation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS stock_lot_event_lot_idx
  ON public.stock_lot_event_log(lot_id, created_at DESC);
CREATE INDEX IF NOT EXISTS stock_lot_event_correlation_idx
  ON public.stock_lot_event_log(correlation_id);

CREATE TABLE IF NOT EXISTS public.stock_lot_genealogy_edges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_lot_id uuid NOT NULL REFERENCES public.lots(id) ON DELETE RESTRICT,
  child_lot_id uuid NOT NULL REFERENCES public.lots(id) ON DELETE RESTRICT,
  operation_type text NOT NULL,
  qty_contributed numeric(18,3) NOT NULL,
  unit_code text NOT NULL,
  stock_movement_id uuid NULL REFERENCES public.stock_movements(id) ON DELETE RESTRICT,
  correlation_id uuid NOT NULL,
  created_by integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stock_lot_genealogy_not_self_ck CHECK (parent_lot_id <> child_lot_id),
  CONSTRAINT stock_lot_genealogy_qty_ck CHECK (qty_contributed > 0),
  CONSTRAINT stock_lot_genealogy_operation_ck CHECK (operation_type IN ('SPLIT', 'MERGE', 'TRANSFORM'))
);

CREATE UNIQUE INDEX IF NOT EXISTS stock_lot_genealogy_edge_uq
  ON public.stock_lot_genealogy_edges(parent_lot_id, child_lot_id, operation_type, correlation_id);
CREATE INDEX IF NOT EXISTS stock_lot_genealogy_parent_idx
  ON public.stock_lot_genealogy_edges(parent_lot_id, created_at DESC);
CREATE INDEX IF NOT EXISTS stock_lot_genealogy_child_idx
  ON public.stock_lot_genealogy_edges(child_lot_id, created_at DESC);

DROP TRIGGER IF EXISTS trg_protect_stock_lot_event ON public.stock_lot_event_log;
CREATE TRIGGER trg_protect_stock_lot_event
BEFORE UPDATE OR DELETE ON public.stock_lot_event_log
FOR EACH ROW EXECUTE FUNCTION public.fn_protect_stock_immutable_evidence();

DROP TRIGGER IF EXISTS trg_protect_stock_lot_genealogy ON public.stock_lot_genealogy_edges;
CREATE TRIGGER trg_protect_stock_lot_genealogy
BEFORE UPDATE OR DELETE ON public.stock_lot_genealogy_edges
FOR EACH ROW EXECUTE FUNCTION public.fn_protect_stock_immutable_evidence();

/* -------------------------------------------------------------------------- */
/* Inventory snapshot, append-only counts, approval and cancellation          */
/* -------------------------------------------------------------------------- */

ALTER TABLE public.stock_inventory_sessions
  DROP CONSTRAINT IF EXISTS stock_inventory_sessions_status_check;

ALTER TABLE public.stock_inventory_sessions
  ALTER COLUMN started_at DROP NOT NULL,
  ALTER COLUMN started_at DROP DEFAULT;

ALTER TABLE public.stock_inventory_sessions
  ADD COLUMN IF NOT EXISTS scope_magasin_id uuid NULL,
  ADD COLUMN IF NOT EXISTS scope_emplacement_id bigint NULL,
  ADD COLUMN IF NOT EXISTS scope_article_id uuid NULL,
  ADD COLUMN IF NOT EXISTS scope_article_category text NULL,
  ADD COLUMN IF NOT EXISTS blind_count boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS requires_second_count boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS snapshot_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS approved_by integer NULL,
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS cancelled_by integer NULL,
  ADD COLUMN IF NOT EXISTS cancellation_reason text NULL,
  ADD COLUMN IF NOT EXISTS row_version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS correlation_id uuid NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stock_inventory_sessions_status_check'
      AND conrelid = 'public.stock_inventory_sessions'::regclass
  ) THEN
    ALTER TABLE public.stock_inventory_sessions
      ADD CONSTRAINT stock_inventory_sessions_status_check
      CHECK (status IN ('DRAFT', 'OPEN', 'APPROVED', 'CLOSED', 'CANCELLED'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stock_inventory_sessions_scope_magasin_fkey'
      AND conrelid = 'public.stock_inventory_sessions'::regclass
  ) THEN
    ALTER TABLE public.stock_inventory_sessions
      ADD CONSTRAINT stock_inventory_sessions_scope_magasin_fkey
      FOREIGN KEY (scope_magasin_id) REFERENCES public.magasins(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stock_inventory_sessions_scope_emplacement_fkey'
      AND conrelid = 'public.stock_inventory_sessions'::regclass
  ) THEN
    ALTER TABLE public.stock_inventory_sessions
      ADD CONSTRAINT stock_inventory_sessions_scope_emplacement_fkey
      FOREIGN KEY (scope_emplacement_id) REFERENCES public.emplacements(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stock_inventory_sessions_scope_article_fkey'
      AND conrelid = 'public.stock_inventory_sessions'::regclass
  ) THEN
    ALTER TABLE public.stock_inventory_sessions
      ADD CONSTRAINT stock_inventory_sessions_scope_article_fkey
      FOREIGN KEY (scope_article_id) REFERENCES public.articles(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stock_inventory_sessions_approved_by_fkey'
      AND conrelid = 'public.stock_inventory_sessions'::regclass
  ) THEN
    ALTER TABLE public.stock_inventory_sessions
      ADD CONSTRAINT stock_inventory_sessions_approved_by_fkey
      FOREIGN KEY (approved_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'stock_inventory_sessions_cancelled_by_fkey'
      AND conrelid = 'public.stock_inventory_sessions'::regclass
  ) THEN
    ALTER TABLE public.stock_inventory_sessions
      ADD CONSTRAINT stock_inventory_sessions_cancelled_by_fkey
      FOREIGN KEY (cancelled_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.stock_inventory_snapshot_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES public.stock_inventory_sessions(id) ON DELETE RESTRICT,
  line_no integer NOT NULL,
  article_id uuid NOT NULL REFERENCES public.articles(id) ON DELETE RESTRICT,
  magasin_id uuid NOT NULL REFERENCES public.magasins(id) ON DELETE RESTRICT,
  emplacement_id bigint NOT NULL REFERENCES public.emplacements(id) ON DELETE RESTRICT,
  lot_id uuid NULL REFERENCES public.lots(id) ON DELETE RESTRICT,
  stock_level_id uuid NOT NULL REFERENCES public.stock_levels(id) ON DELETE RESTRICT,
  stock_batch_id uuid NULL REFERENCES public.stock_batches(id) ON DELETE RESTRICT,
  theoretical_qty numeric(18,3) NOT NULL,
  unit_code text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS stock_inventory_snapshot_line_no_uq
  ON public.stock_inventory_snapshot_lines(session_id, line_no);
CREATE UNIQUE INDEX IF NOT EXISTS stock_inventory_snapshot_no_lot_uq
  ON public.stock_inventory_snapshot_lines(session_id, article_id, emplacement_id)
  WHERE lot_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS stock_inventory_snapshot_with_lot_uq
  ON public.stock_inventory_snapshot_lines(session_id, article_id, emplacement_id, lot_id)
  WHERE lot_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.stock_inventory_count_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES public.stock_inventory_sessions(id) ON DELETE RESTRICT,
  snapshot_line_id uuid NOT NULL REFERENCES public.stock_inventory_snapshot_lines(id) ON DELETE RESTRICT,
  count_round integer NOT NULL,
  counted_qty numeric(18,3) NOT NULL,
  reason_code text NULL,
  note text NULL,
  actor_user_id integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  correlation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stock_inventory_count_round_ck CHECK (count_round IN (1, 2)),
  CONSTRAINT stock_inventory_count_qty_ck CHECK (counted_qty >= 0)
);

CREATE INDEX IF NOT EXISTS stock_inventory_count_session_idx
  ON public.stock_inventory_count_events(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS stock_inventory_count_line_idx
  ON public.stock_inventory_count_events(snapshot_line_id, count_round, created_at DESC);

DROP TRIGGER IF EXISTS trg_protect_stock_inventory_snapshot ON public.stock_inventory_snapshot_lines;
CREATE TRIGGER trg_protect_stock_inventory_snapshot
BEFORE UPDATE OR DELETE ON public.stock_inventory_snapshot_lines
FOR EACH ROW EXECUTE FUNCTION public.fn_protect_stock_immutable_evidence();

DROP TRIGGER IF EXISTS trg_protect_stock_inventory_count ON public.stock_inventory_count_events;
CREATE TRIGGER trg_protect_stock_inventory_count
BEFORE UPDATE OR DELETE ON public.stock_inventory_count_events
FOR EACH ROW EXECUTE FUNCTION public.fn_protect_stock_immutable_evidence();

CREATE OR REPLACE FUNCTION public.fn_protect_stock_inventory_session()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'inventory sessions cannot be deleted'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.status IN ('CLOSED', 'CANCELLED') THEN
    RAISE EXCEPTION 'closed or cancelled inventory sessions are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.status <> 'DRAFT' AND (
    NEW.scope_magasin_id IS DISTINCT FROM OLD.scope_magasin_id
    OR NEW.scope_emplacement_id IS DISTINCT FROM OLD.scope_emplacement_id
    OR NEW.scope_article_id IS DISTINCT FROM OLD.scope_article_id
    OR NEW.scope_article_category IS DISTINCT FROM OLD.scope_article_category
    OR NEW.blind_count IS DISTINCT FROM OLD.blind_count
    OR NEW.requires_second_count IS DISTINCT FROM OLD.requires_second_count
    OR NEW.snapshot_at IS DISTINCT FROM OLD.snapshot_at
  ) THEN
    RAISE EXCEPTION 'inventory scope and snapshot are frozen after start'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_protect_stock_inventory_line()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  session_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'inventory lines cannot be deleted'
      USING ERRCODE = '55000';
  END IF;

  SELECT status INTO session_status
  FROM public.stock_inventory_sessions
  WHERE id = NEW.session_id;
  IF session_status <> 'OPEN' THEN
    RAISE EXCEPTION 'inventory lines are editable only while the session is open'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_stock_inventory_session ON public.stock_inventory_sessions;
CREATE TRIGGER trg_protect_stock_inventory_session
BEFORE UPDATE OR DELETE ON public.stock_inventory_sessions
FOR EACH ROW EXECUTE FUNCTION public.fn_protect_stock_inventory_session();

DROP TRIGGER IF EXISTS trg_protect_stock_inventory_line ON public.stock_inventory_lines;
CREATE TRIGGER trg_protect_stock_inventory_line
BEFORE INSERT OR UPDATE OR DELETE ON public.stock_inventory_lines
FOR EACH ROW EXECUTE FUNCTION public.fn_protect_stock_inventory_line();

DROP TRIGGER IF EXISTS trg_protect_stock_inventory_session_movement
  ON public.stock_inventory_session_movements;
CREATE TRIGGER trg_protect_stock_inventory_session_movement
BEFORE UPDATE OR DELETE ON public.stock_inventory_session_movements
FOR EACH ROW EXECUTE FUNCTION public.fn_protect_stock_immutable_evidence();

/* -------------------------------------------------------------------------- */
/* Authoritative availability projection                                      */
/* -------------------------------------------------------------------------- */

CREATE OR REPLACE VIEW public.v_stock_availability_225 AS
WITH scrap_flow AS (
  SELECT
    movement.stock_level_id,
    movement.stock_batch_id,
    SUM(ABS(movement.qty))::numeric AS qty_scrap_recorded
  FROM public.stock_movements movement
  WHERE movement.status::text = 'POSTED'
    AND movement.movement_type::text = 'SCRAP'
  GROUP BY movement.stock_level_id, movement.stock_batch_id
),
batch_rows AS (
  SELECT
    batch.id AS availability_id,
    level.id AS stock_level_id,
    batch.id AS stock_batch_id,
    level.article_id,
    level.warehouse_id,
    level.location_id,
    level.unit_id,
    level.managed_in_stock,
    batch.lot_id,
    lot.lot_code,
    lot.lot_status,
    batch.qty_total,
    batch.qty_reserved,
    batch.qty_depreciated,
    level.updated_at
  FROM public.stock_batches batch
  JOIN public.stock_levels level ON level.id = batch.stock_level_id
  LEFT JOIN public.lots lot ON lot.id = batch.lot_id
),
unbatched_rows AS (
  SELECT
    level.id AS availability_id,
    level.id AS stock_level_id,
    NULL::uuid AS stock_batch_id,
    level.article_id,
    level.warehouse_id,
    level.location_id,
    level.unit_id,
    level.managed_in_stock,
    NULL::uuid AS lot_id,
    NULL::text AS lot_code,
    NULL::text AS lot_status,
    level.qty_total,
    level.qty_reserved,
    level.qty_depreciated,
    level.updated_at
  FROM public.stock_levels level
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.stock_batches batch
    WHERE batch.stock_level_id = level.id
  )
),
availability_rows AS (
  SELECT * FROM batch_rows
  UNION ALL
  SELECT * FROM unbatched_rows
)
SELECT
  row.availability_id AS id,
  row.availability_id,
  row.stock_level_id,
  row.stock_batch_id,
  row.article_id,
  row.warehouse_id,
  row.location_id,
  row.unit_id,
  row.managed_in_stock,
  row.lot_id,
  row.lot_code,
  row.lot_status,
  row.qty_total,
  row.qty_total AS qty_on_hand,
  row.qty_reserved,
  row.qty_depreciated,
  CASE
    WHEN row.lot_status IN ('EN_ATTENTE', 'QUARANTAINE')
      THEN GREATEST(row.qty_total - row.qty_depreciated, 0)
    ELSE 0
  END AS qty_quarantine,
  CASE
    WHEN row.lot_status = 'BLOQUE'
      THEN GREATEST(row.qty_total - row.qty_depreciated, 0)
    ELSE 0
  END AS qty_blocked,
  CASE
    WHEN row.lot_status IS NULL OR row.lot_status = 'LIBERE'
      THEN GREATEST(row.qty_total - row.qty_reserved - row.qty_depreciated, 0)
    ELSE 0
  END AS qty_available,
  COALESCE(scrap.qty_scrap_recorded, 0) AS qty_scrap_recorded,
  row.updated_at
FROM availability_rows row
LEFT JOIN scrap_flow scrap
  ON scrap.stock_level_id = row.stock_level_id
 AND scrap.stock_batch_id IS NOT DISTINCT FROM row.stock_batch_id;

COMMENT ON VIEW public.v_stock_availability_225 IS
  'Issue #225 authoritative physical, reserved, depreciated, quarantine, blocked and available stock by level/batch.';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app') THEN
    GRANT SELECT, INSERT ON public.stock_command_receipts TO cerp_app;
    GRANT SELECT, INSERT ON public.stock_reservation_event_log TO cerp_app;
    GRANT SELECT, INSERT ON public.stock_lot_event_log TO cerp_app;
    GRANT SELECT, INSERT ON public.stock_lot_genealogy_edges TO cerp_app;
    GRANT SELECT, INSERT ON public.stock_inventory_snapshot_lines TO cerp_app;
    GRANT SELECT, INSERT ON public.stock_inventory_count_events TO cerp_app;
    GRANT SELECT ON public.v_stock_availability_225 TO cerp_app;
  END IF;
END $$;

COMMIT;
