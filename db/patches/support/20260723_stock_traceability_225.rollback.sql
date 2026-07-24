\set ON_ERROR_STOP on

-- Guarded compensation for an empty #225 installation only.
-- Never run after any #225 command, reservation event, lot event, genealogy
-- edge, inventory snapshot or inventory count has been recorded.
BEGIN;

DO $$
BEGIN
  IF current_database() <> 'cerp_test' THEN
    RAISE EXCEPTION '#225 rollback is restricted to cerp_test';
  END IF;

  IF EXISTS (SELECT 1 FROM public.stock_command_receipts)
     OR EXISTS (SELECT 1 FROM public.stock_reservation_event_log)
     OR EXISTS (SELECT 1 FROM public.stock_lot_event_log)
     OR EXISTS (SELECT 1 FROM public.stock_lot_genealogy_edges)
     OR EXISTS (SELECT 1 FROM public.stock_inventory_snapshot_lines)
     OR EXISTS (SELECT 1 FROM public.stock_inventory_count_events)
     OR EXISTS (
       SELECT 1
       FROM public.stock_movements
       WHERE correlation_id IS NOT NULL OR reversal_of_id IS NOT NULL
     )
     OR EXISTS (
       SELECT 1
       FROM public.stock_inventory_sessions
       WHERE status NOT IN ('OPEN', 'CLOSED')
          OR started_at IS NULL
          OR scope_magasin_id IS NOT NULL
          OR scope_emplacement_id IS NOT NULL
          OR scope_article_id IS NOT NULL
          OR scope_article_category IS NOT NULL
          OR blind_count
          OR requires_second_count
          OR snapshot_at IS NOT NULL
          OR approved_at IS NOT NULL
          OR cancelled_at IS NOT NULL
          OR correlation_id IS NOT NULL
          OR row_version <> 1
     ) THEN
    RAISE EXCEPTION '#225 rollback refused: immutable stock evidence exists';
  END IF;
END $$;

DROP VIEW IF EXISTS public.v_stock_availability_225;

DROP INDEX IF EXISTS public.stock_inventory_count_line_idx;
DROP INDEX IF EXISTS public.stock_inventory_count_session_idx;
DROP INDEX IF EXISTS public.stock_inventory_snapshot_with_lot_uq;
DROP INDEX IF EXISTS public.stock_inventory_snapshot_no_lot_uq;
DROP INDEX IF EXISTS public.stock_inventory_snapshot_line_no_uq;
DROP INDEX IF EXISTS public.stock_lot_genealogy_child_idx;
DROP INDEX IF EXISTS public.stock_lot_genealogy_parent_idx;
DROP INDEX IF EXISTS public.stock_lot_genealogy_edge_uq;
DROP INDEX IF EXISTS public.stock_lot_event_correlation_idx;
DROP INDEX IF EXISTS public.stock_lot_event_lot_idx;
DROP INDEX IF EXISTS public.stock_reservation_event_correlation_idx;
DROP INDEX IF EXISTS public.stock_reservation_event_reservation_idx;
DROP INDEX IF EXISTS public.stock_reservations_correlation_idx;
DROP INDEX IF EXISTS public.stock_reservations_expiry_idx;
DROP INDEX IF EXISTS public.stock_command_receipts_correlation_idx;
DROP INDEX IF EXISTS public.stock_command_receipts_resource_idx;
DROP INDEX IF EXISTS public.stock_movements_correlation_idx;
DROP INDEX IF EXISTS public.stock_movements_reversal_once_uq;
DROP INDEX IF EXISTS public.emplacements_location_type_idx;

DROP TRIGGER IF EXISTS trg_protect_stock_inventory_count ON public.stock_inventory_count_events;
DROP TRIGGER IF EXISTS trg_protect_stock_inventory_snapshot ON public.stock_inventory_snapshot_lines;
DROP TRIGGER IF EXISTS trg_protect_stock_inventory_session_movement ON public.stock_inventory_session_movements;
DROP TRIGGER IF EXISTS trg_protect_stock_inventory_line ON public.stock_inventory_lines;
DROP TRIGGER IF EXISTS trg_protect_stock_inventory_session ON public.stock_inventory_sessions;
DROP TRIGGER IF EXISTS trg_protect_stock_lot_genealogy ON public.stock_lot_genealogy_edges;
DROP TRIGGER IF EXISTS trg_protect_stock_lot_event ON public.stock_lot_event_log;
DROP TRIGGER IF EXISTS trg_protect_stock_reservation_event ON public.stock_reservation_event_log;
DROP TRIGGER IF EXISTS trg_log_stock_reservation_event ON public.stock_reservations;
DROP TRIGGER IF EXISTS trg_prepare_stock_reservation ON public.stock_reservations;
DROP TRIGGER IF EXISTS trg_protect_stock_command_receipt ON public.stock_command_receipts;
DROP TRIGGER IF EXISTS trg_protect_stock_movement_event ON public.stock_movement_event_log;
DROP TRIGGER IF EXISTS trg_protect_posted_stock_movement_line ON public.stock_movement_lines;
DROP TRIGGER IF EXISTS trg_protect_posted_stock_movement ON public.stock_movements;

DROP TABLE IF EXISTS public.stock_inventory_count_events;
DROP TABLE IF EXISTS public.stock_inventory_snapshot_lines;
DROP TABLE IF EXISTS public.stock_lot_genealogy_edges;
DROP TABLE IF EXISTS public.stock_lot_event_log;
DROP TABLE IF EXISTS public.stock_reservation_event_log;
DROP TABLE IF EXISTS public.stock_command_receipts;

DROP FUNCTION IF EXISTS public.fn_protect_posted_stock_movement_line();
DROP FUNCTION IF EXISTS public.fn_protect_posted_stock_movement();
DROP FUNCTION IF EXISTS public.fn_protect_stock_inventory_line();
DROP FUNCTION IF EXISTS public.fn_protect_stock_inventory_session();
DROP FUNCTION IF EXISTS public.fn_log_stock_reservation_event();
DROP FUNCTION IF EXISTS public.fn_prepare_stock_reservation();
DROP FUNCTION IF EXISTS public.fn_protect_stock_immutable_evidence();

ALTER TABLE public.stock_inventory_sessions
  DROP CONSTRAINT IF EXISTS stock_inventory_sessions_scope_magasin_fkey,
  DROP CONSTRAINT IF EXISTS stock_inventory_sessions_scope_emplacement_fkey,
  DROP CONSTRAINT IF EXISTS stock_inventory_sessions_scope_article_fkey,
  DROP CONSTRAINT IF EXISTS stock_inventory_sessions_approved_by_fkey,
  DROP CONSTRAINT IF EXISTS stock_inventory_sessions_cancelled_by_fkey,
  DROP CONSTRAINT IF EXISTS stock_inventory_sessions_status_check,
  DROP COLUMN IF EXISTS scope_magasin_id,
  DROP COLUMN IF EXISTS scope_emplacement_id,
  DROP COLUMN IF EXISTS scope_article_id,
  DROP COLUMN IF EXISTS scope_article_category,
  DROP COLUMN IF EXISTS blind_count,
  DROP COLUMN IF EXISTS requires_second_count,
  DROP COLUMN IF EXISTS snapshot_at,
  DROP COLUMN IF EXISTS approved_at,
  DROP COLUMN IF EXISTS approved_by,
  DROP COLUMN IF EXISTS cancelled_at,
  DROP COLUMN IF EXISTS cancelled_by,
  DROP COLUMN IF EXISTS cancellation_reason,
  DROP COLUMN IF EXISTS row_version,
  DROP COLUMN IF EXISTS correlation_id,
  ALTER COLUMN started_at SET DEFAULT now(),
  ALTER COLUMN started_at SET NOT NULL;

ALTER TABLE public.stock_inventory_sessions
  ADD CONSTRAINT stock_inventory_sessions_status_check
  CHECK (status IN ('OPEN', 'CLOSED'));

ALTER TABLE public.stock_reservations
  DROP CONSTRAINT IF EXISTS stock_reservations_consumed_movement_fkey,
  DROP CONSTRAINT IF EXISTS stock_reservations_commande_ligne_fkey,
  DROP CONSTRAINT IF EXISTS stock_reservations_of_fkey,
  DROP CONSTRAINT IF EXISTS stock_reservations_bon_livraison_ligne_fkey,
  DROP CONSTRAINT IF EXISTS stock_reservations_affaire_fkey,
  DROP CONSTRAINT IF EXISTS stock_reservations_released_by_fkey,
  DROP CONSTRAINT IF EXISTS stock_reservations_consumed_by_fkey,
  DROP CONSTRAINT IF EXISTS stock_reservations_status_225_ck,
  DROP COLUMN IF EXISTS correlation_id,
  DROP COLUMN IF EXISTS commande_ligne_id,
  DROP COLUMN IF EXISTS of_id,
  DROP COLUMN IF EXISTS bon_livraison_ligne_id,
  DROP COLUMN IF EXISTS affaire_id,
  DROP COLUMN IF EXISTS reason,
  DROP COLUMN IF EXISTS expires_at,
  DROP COLUMN IF EXISTS released_at,
  DROP COLUMN IF EXISTS released_by,
  DROP COLUMN IF EXISTS consumed_at,
  DROP COLUMN IF EXISTS consumed_by,
  DROP COLUMN IF EXISTS consumed_stock_movement_id,
  DROP COLUMN IF EXISTS row_version;

ALTER TABLE public.stock_movements
  DROP CONSTRAINT IF EXISTS stock_movements_reversal_of_id_fkey,
  DROP CONSTRAINT IF EXISTS stock_movements_not_self_reversal_ck,
  DROP COLUMN IF EXISTS correlation_id,
  DROP COLUMN IF EXISTS reversal_of_id;

ALTER TABLE public.emplacements
  DROP CONSTRAINT IF EXISTS emplacements_location_type_ck,
  DROP CONSTRAINT IF EXISTS emplacements_restrictions_object_ck,
  DROP COLUMN IF EXISTS location_type,
  DROP COLUMN IF EXISTS allow_inbound,
  DROP COLUMN IF EXISTS allow_outbound,
  DROP COLUMN IF EXISTS restrictions;

COMMIT;
