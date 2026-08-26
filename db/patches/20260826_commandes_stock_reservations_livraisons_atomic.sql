-- Commande -> reservation -> OF receipt -> delivery preparation/ship.
-- Additive and idempotent.  Do not apply this patch automatically in production.
-- The patch deliberately keeps legacy stock_reservations rows readable: all new
-- traceability columns are nullable and legacy rows retain their existing source.

BEGIN;

/* -------------------------------------------------------------------------- */
/* 1) Lot provenance and allocation counters                                  */
/* -------------------------------------------------------------------------- */

ALTER TABLE public.lots
  ADD COLUMN IF NOT EXISTS source_scope TEXT NULL;

UPDATE public.lots
SET source_scope = 'NEW'
WHERE source_scope IS NULL;

ALTER TABLE public.lots
  ALTER COLUMN source_scope SET DEFAULT 'NEW';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'lots_source_scope_chk'
      AND conrelid = 'public.lots'::regclass
  ) THEN
    ALTER TABLE public.lots
      ADD CONSTRAINT lots_source_scope_chk
      CHECK (source_scope IS NULL OR source_scope IN ('OLD', 'NEW'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS lots_source_scope_fifo_idx
  ON public.lots (article_id, source_scope, received_at NULLS LAST, created_at, id);

ALTER TABLE public.commande_ligne_affaire_allocation
  ADD COLUMN IF NOT EXISTS qty_produced NUMERIC(18, 3) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS qty_stocked NUMERIC(18, 3) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS qty_delivered NUMERIC(18, 3) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS qty_remaining NUMERIC(18, 3) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS allocation_version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS delivery_status TEXT NOT NULL DEFAULT 'A_PREPARER';

UPDATE public.commande_ligne_affaire_allocation
SET qty_remaining = GREATEST(0, qty_ordered - COALESCE(qty_delivered, 0))
WHERE qty_remaining = 0
  AND COALESCE(qty_delivered, 0) = 0;

UPDATE public.commande_ligne_affaire_allocation
SET delivery_status = CASE
  WHEN COALESCE(qty_delivered, 0) >= qty_ordered THEN 'LIVREE'
  WHEN COALESCE(qty_delivered, 0) > 0 THEN 'PARTIELLEMENT_LIVREE'
  ELSE 'A_PREPARER'
END
WHERE delivery_status = 'A_PREPARER'
  AND COALESCE(qty_delivered, 0) > 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'commande_ligne_affaire_allocation_progress_chk'
      AND conrelid = 'public.commande_ligne_affaire_allocation'::regclass
  ) THEN
    ALTER TABLE public.commande_ligne_affaire_allocation
      ADD CONSTRAINT commande_ligne_affaire_allocation_progress_chk
      CHECK (
        qty_produced >= 0 AND qty_stocked >= 0 AND qty_delivered >= 0
        AND qty_remaining >= 0 AND qty_delivered <= qty_ordered
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'commande_ligne_affaire_allocation_delivery_status_chk'
      AND conrelid = 'public.commande_ligne_affaire_allocation'::regclass
  ) THEN
    ALTER TABLE public.commande_ligne_affaire_allocation
      ADD CONSTRAINT commande_ligne_affaire_allocation_delivery_status_chk
      CHECK (delivery_status IN ('A_PREPARER', 'PARTIELLEMENT_LIVREE', 'LIVREE'));
  END IF;
END $$;

/* -------------------------------------------------------------------------- */
/* 2) Reservation spine                                                        */
/* -------------------------------------------------------------------------- */

ALTER TABLE public.stock_reservations
  ADD COLUMN IF NOT EXISTS commande_ligne_affaire_allocation_id BIGINT NULL,
  ADD COLUMN IF NOT EXISTS livraison_affaire_id BIGINT NULL,
  ADD COLUMN IF NOT EXISTS lot_id UUID NULL,
  ADD COLUMN IF NOT EXISTS stock_level_id UUID NULL,
  ADD COLUMN IF NOT EXISTS stock_batch_id UUID NULL,
  ADD COLUMN IF NOT EXISTS of_id BIGINT NULL,
  ADD COLUMN IF NOT EXISTS source_scope TEXT NULL,
  ADD COLUMN IF NOT EXISTS qty_consumed NUMERIC(18, 3) NOT NULL DEFAULT 0,
  -- Held by a DRAFT/READY reservation-backed BL.  This is intentionally
  -- separate from `qty_consumed`: preparation must block a second BL without
  -- pretending that the physical stock has already left the warehouse.
  ADD COLUMN IF NOT EXISTS qty_prepared NUMERIC(18, 3) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT NULL,
  ADD COLUMN IF NOT EXISTS request_hash TEXT NULL,
  ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS consumed_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS released_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS release_reason TEXT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_reservations_source_scope_chk' AND conrelid = 'public.stock_reservations'::regclass) THEN
    ALTER TABLE public.stock_reservations
      ADD CONSTRAINT stock_reservations_source_scope_chk
      CHECK (source_scope IS NULL OR source_scope IN ('OLD', 'NEW'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_reservations_status_v2_chk' AND conrelid = 'public.stock_reservations'::regclass) THEN
    ALTER TABLE public.stock_reservations
      ADD CONSTRAINT stock_reservations_status_v2_chk
      -- Keep historical rows readable even if a former module used another
      -- terminal value.  New writes are still checked by PostgreSQL.
      CHECK (status IN ('ACTIVE', 'RELEASED', 'CONSUMED', 'CANCELLED')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_reservations_consumed_chk' AND conrelid = 'public.stock_reservations'::regclass) THEN
    ALTER TABLE public.stock_reservations
      ADD CONSTRAINT stock_reservations_consumed_chk
      CHECK (qty_consumed >= 0 AND qty_consumed <= qty_reserved);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_reservations_prepared_chk' AND conrelid = 'public.stock_reservations'::regclass) THEN
    ALTER TABLE public.stock_reservations
      ADD CONSTRAINT stock_reservations_prepared_chk
      CHECK (qty_prepared >= 0 AND qty_consumed + qty_prepared <= qty_reserved);
  END IF;
  IF to_regclass('public.commande_ligne_affaire_allocation') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_reservations_allocation_fkey' AND conrelid = 'public.stock_reservations'::regclass) THEN
    ALTER TABLE public.stock_reservations
      ADD CONSTRAINT stock_reservations_allocation_fkey
      FOREIGN KEY (commande_ligne_affaire_allocation_id)
      REFERENCES public.commande_ligne_affaire_allocation(id) ON DELETE SET NULL;
  END IF;
  IF to_regclass('public.affaire') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_reservations_livraison_affaire_fkey' AND conrelid = 'public.stock_reservations'::regclass) THEN
    ALTER TABLE public.stock_reservations
      ADD CONSTRAINT stock_reservations_livraison_affaire_fkey
      FOREIGN KEY (livraison_affaire_id) REFERENCES public.affaire(id) ON DELETE SET NULL;
  END IF;
  IF to_regclass('public.lots') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_reservations_lot_fkey' AND conrelid = 'public.stock_reservations'::regclass) THEN
    ALTER TABLE public.stock_reservations
      ADD CONSTRAINT stock_reservations_lot_fkey
      FOREIGN KEY (lot_id) REFERENCES public.lots(id) ON DELETE SET NULL;
  END IF;
  IF to_regclass('public.stock_levels') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_reservations_stock_level_fkey' AND conrelid = 'public.stock_reservations'::regclass) THEN
    ALTER TABLE public.stock_reservations
      ADD CONSTRAINT stock_reservations_stock_level_fkey
      FOREIGN KEY (stock_level_id) REFERENCES public.stock_levels(id) ON DELETE SET NULL;
  END IF;
  IF to_regclass('public.stock_batches') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_reservations_stock_batch_fkey' AND conrelid = 'public.stock_reservations'::regclass) THEN
    ALTER TABLE public.stock_reservations
      ADD CONSTRAINT stock_reservations_stock_batch_fkey
      FOREIGN KEY (stock_batch_id) REFERENCES public.stock_batches(id) ON DELETE SET NULL;
  END IF;
  IF to_regclass('public.ordres_fabrication') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_reservations_of_fkey' AND conrelid = 'public.stock_reservations'::regclass) THEN
    ALTER TABLE public.stock_reservations
      ADD CONSTRAINT stock_reservations_of_fkey
      FOREIGN KEY (of_id) REFERENCES public.ordres_fabrication(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS stock_reservations_allocation_idx
  ON public.stock_reservations (commande_ligne_affaire_allocation_id, status);
CREATE INDEX IF NOT EXISTS stock_reservations_lot_batch_idx
  ON public.stock_reservations (lot_id, stock_batch_id, status);

-- Do not silently merge historical reservations: their audit/source data may
-- differ.  Stop the deployment before creating the uniqueness guard and let
-- the operator reconcile each duplicate with the support query/ledger.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.stock_reservations
    WHERE status = 'ACTIVE'
      AND commande_ligne_affaire_allocation_id IS NOT NULL
      AND stock_batch_id IS NOT NULL
    GROUP BY commande_ligne_affaire_allocation_id, stock_batch_id
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'integrity_constraint_violation',
      MESSAGE = 'Cannot create stock_reservations_active_allocation_batch_uniq: duplicate ACTIVE allocation/batch reservations exist',
      HINT = 'Run db/patches/support/20260826_commandes_stock_reservations_livraisons_atomic.verify.sql, reconcile duplicates with audit preservation, then retry the patch.';
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS stock_reservations_active_allocation_batch_uniq
  ON public.stock_reservations (commande_ligne_affaire_allocation_id, stock_batch_id)
  WHERE status = 'ACTIVE'
    AND commande_ligne_affaire_allocation_id IS NOT NULL
    AND stock_batch_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS stock_reservations_actor_idempotency_uniq
  ON public.stock_reservations (created_by, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

/* -------------------------------------------------------------------------- */
/* 3) Immutable OF-receipt idempotency ledger                                  */
/* -------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS public.of_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  of_id BIGINT NOT NULL,
  actor_user_id INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  expected_of_updated_at TIMESTAMPTZ NOT NULL,
  request_payload JSONB NOT NULL,
  result_payload JSONB NULL,
  lot_id UUID NULL,
  stock_movement_id UUID NULL,
  reservation_id UUID NULL,
  qty_ok NUMERIC(18, 3) NOT NULL,
  qty_scrap NUMERIC(18, 3) NOT NULL DEFAULT 0,
  qty_rework NUMERIC(18, 3) NOT NULL DEFAULT 0,
  quality_status TEXT NOT NULL DEFAULT 'LIBERE',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT of_receipts_idempotency_key_len_chk CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
  CONSTRAINT of_receipts_qty_ok_chk CHECK (qty_ok > 0),
  CONSTRAINT of_receipts_qty_scrap_chk CHECK (qty_scrap >= 0),
  CONSTRAINT of_receipts_qty_rework_chk CHECK (qty_rework >= 0),
  CONSTRAINT of_receipts_quality_status_chk CHECK (quality_status IN ('LIBERE', 'QUARANTAINE', 'BLOQUE')),
  CONSTRAINT of_receipts_actor_key_uniq UNIQUE (actor_user_id, idempotency_key)
);

ALTER TABLE public.of_receipts
  ADD COLUMN IF NOT EXISTS qty_scrap NUMERIC(18, 3) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS qty_rework NUMERIC(18, 3) NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'of_receipts_qty_scrap_chk' AND conrelid = 'public.of_receipts'::regclass) THEN
    ALTER TABLE public.of_receipts ADD CONSTRAINT of_receipts_qty_scrap_chk CHECK (qty_scrap >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'of_receipts_qty_rework_chk' AND conrelid = 'public.of_receipts'::regclass) THEN
    ALTER TABLE public.of_receipts ADD CONSTRAINT of_receipts_qty_rework_chk CHECK (qty_rework >= 0);
  END IF;
  IF to_regclass('public.ordres_fabrication') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'of_receipts_of_fkey' AND conrelid = 'public.of_receipts'::regclass) THEN
    ALTER TABLE public.of_receipts ADD CONSTRAINT of_receipts_of_fkey FOREIGN KEY (of_id) REFERENCES public.ordres_fabrication(id) ON DELETE RESTRICT;
  END IF;
  IF to_regclass('public.users') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'of_receipts_actor_fkey' AND conrelid = 'public.of_receipts'::regclass) THEN
    ALTER TABLE public.of_receipts ADD CONSTRAINT of_receipts_actor_fkey FOREIGN KEY (actor_user_id) REFERENCES public.users(id) ON DELETE RESTRICT;
  END IF;
  IF to_regclass('public.lots') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'of_receipts_lot_fkey' AND conrelid = 'public.of_receipts'::regclass) THEN
    ALTER TABLE public.of_receipts ADD CONSTRAINT of_receipts_lot_fkey FOREIGN KEY (lot_id) REFERENCES public.lots(id) ON DELETE SET NULL;
  END IF;
  IF to_regclass('public.stock_movements') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'of_receipts_movement_fkey' AND conrelid = 'public.of_receipts'::regclass) THEN
    ALTER TABLE public.of_receipts ADD CONSTRAINT of_receipts_movement_fkey FOREIGN KEY (stock_movement_id) REFERENCES public.stock_movements(id) ON DELETE SET NULL;
  END IF;
  IF to_regclass('public.stock_reservations') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'of_receipts_reservation_fkey' AND conrelid = 'public.of_receipts'::regclass) THEN
    ALTER TABLE public.of_receipts ADD CONSTRAINT of_receipts_reservation_fkey FOREIGN KEY (reservation_id) REFERENCES public.stock_reservations(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS of_receipts_of_created_idx ON public.of_receipts (of_id, created_at DESC);

/* -------------------------------------------------------------------------- */
/* 4) BL preparation, verification, idempotent shipping and outbox            */
/* -------------------------------------------------------------------------- */

ALTER TABLE public.bon_livraison
  ADD COLUMN IF NOT EXISTS shipping_version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS shipping_preview_hash TEXT NULL,
  ADD COLUMN IF NOT EXISTS shipped_at TIMESTAMPTZ NULL;

ALTER TABLE public.bon_livraison_ligne_allocations
  ADD COLUMN IF NOT EXISTS reservation_id UUID NULL,
  ADD COLUMN IF NOT EXISTS magasin_id UUID NULL,
  ADD COLUMN IF NOT EXISTS emplacement_id BIGINT NULL,
  ADD COLUMN IF NOT EXISTS location_id UUID NULL,
  ADD COLUMN IF NOT EXISTS stock_level_id UUID NULL,
  ADD COLUMN IF NOT EXISTS stock_batch_id UUID NULL,
  ADD COLUMN IF NOT EXISTS commande_ligne_affaire_allocation_id BIGINT NULL,
  ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS verified_by INTEGER NULL,
  ADD COLUMN IF NOT EXISTS verification_snapshot JSONB NULL,
  ADD COLUMN IF NOT EXISTS qty_consumed NUMERIC(18, 3) NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bon_livraison_ligne_allocations_consumed_chk' AND conrelid = 'public.bon_livraison_ligne_allocations'::regclass) THEN
    ALTER TABLE public.bon_livraison_ligne_allocations
      ADD CONSTRAINT bon_livraison_ligne_allocations_consumed_chk CHECK (qty_consumed >= 0 AND qty_consumed <= quantite);
  END IF;
  IF to_regclass('public.stock_reservations') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bon_livraison_ligne_allocations_reservation_fkey' AND conrelid = 'public.bon_livraison_ligne_allocations'::regclass) THEN
    ALTER TABLE public.bon_livraison_ligne_allocations ADD CONSTRAINT bon_livraison_ligne_allocations_reservation_fkey FOREIGN KEY (reservation_id) REFERENCES public.stock_reservations(id) ON DELETE SET NULL;
  END IF;
  IF to_regclass('public.commande_ligne_affaire_allocation') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bon_livraison_ligne_allocations_order_allocation_fkey' AND conrelid = 'public.bon_livraison_ligne_allocations'::regclass) THEN
    ALTER TABLE public.bon_livraison_ligne_allocations ADD CONSTRAINT bon_livraison_ligne_allocations_order_allocation_fkey FOREIGN KEY (commande_ligne_affaire_allocation_id) REFERENCES public.commande_ligne_affaire_allocation(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS bon_livraison_ligne_allocations_reservation_idx ON public.bon_livraison_ligne_allocations (reservation_id);
CREATE INDEX IF NOT EXISTS bon_livraison_ligne_allocations_order_allocation_idx ON public.bon_livraison_ligne_allocations (commande_ligne_affaire_allocation_id);

CREATE TABLE IF NOT EXISTS public.bon_livraison_ship_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bon_livraison_id UUID NOT NULL,
  actor_user_id INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  expected_shipping_version INTEGER NOT NULL,
  preview_hash TEXT NOT NULL,
  result_payload JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT bon_livraison_ship_receipts_key_len_chk CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
  CONSTRAINT bon_livraison_ship_receipts_actor_key_uniq UNIQUE (actor_user_id, idempotency_key)
);

-- Creation from reservations is a separate idempotent command from shipment.
-- The result row is inserted before reservation locks are taken so retries and
-- double-clicks serialize without ever producing a second DRAFT BL.
CREATE TABLE IF NOT EXISTS public.bon_livraison_prepare_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  bon_livraison_id UUID NULL,
  result_payload JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT bon_livraison_prepare_receipts_key_len_chk CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
  CONSTRAINT bon_livraison_prepare_receipts_actor_key_uniq UNIQUE (actor_user_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS public.delivery_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type TEXT NOT NULL,
  aggregate_id UUID NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT delivery_outbox_event_uniq UNIQUE (event_type, aggregate_id)
);

-- A retry reuses the same idempotent outbox row, so its original creation time
-- cannot stand in for the latest print request time.  Preserve both values.
ALTER TABLE public.delivery_outbox
  ADD COLUMN IF NOT EXISTS requested_at TIMESTAMPTZ NULL;
UPDATE public.delivery_outbox
SET requested_at = created_at
WHERE requested_at IS NULL;
ALTER TABLE public.delivery_outbox
  ALTER COLUMN requested_at SET DEFAULT now(),
  ALTER COLUMN requested_at SET NOT NULL;

CREATE TABLE IF NOT EXISTS public.stock_reservation_verifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id UUID NOT NULL,
  verified_qty NUMERIC(18, 3) NOT NULL,
  scanned_lot_code TEXT NOT NULL,
  snapshot JSONB NOT NULL,
  verified_by INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT stock_reservation_verifications_qty_chk CHECK (verified_qty > 0)
);

-- A correction never overwrites a stock balance or a prior scan snapshot.
-- It keeps the before/after payload next to the adjustment movement and gives
-- retries a stable actor-scoped idempotency record.
CREATE TABLE IF NOT EXISTS public.stock_reservation_corrections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id UUID NOT NULL,
  actor_user_id INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  reason TEXT NOT NULL,
  old_snapshot JSONB NOT NULL,
  new_snapshot JSONB NOT NULL,
  stock_movement_id UUID NULL,
  result_payload JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT stock_reservation_corrections_key_len_chk CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
  CONSTRAINT stock_reservation_corrections_actor_key_uniq UNIQUE (actor_user_id, idempotency_key)
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bon_livraison_ship_receipts_bl_fkey' AND conrelid = 'public.bon_livraison_ship_receipts'::regclass) THEN
    ALTER TABLE public.bon_livraison_ship_receipts ADD CONSTRAINT bon_livraison_ship_receipts_bl_fkey FOREIGN KEY (bon_livraison_id) REFERENCES public.bon_livraison(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bon_livraison_ship_receipts_actor_fkey' AND conrelid = 'public.bon_livraison_ship_receipts'::regclass) THEN
    ALTER TABLE public.bon_livraison_ship_receipts ADD CONSTRAINT bon_livraison_ship_receipts_actor_fkey FOREIGN KEY (actor_user_id) REFERENCES public.users(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bon_livraison_prepare_receipts_bl_fkey' AND conrelid = 'public.bon_livraison_prepare_receipts'::regclass) THEN
    ALTER TABLE public.bon_livraison_prepare_receipts ADD CONSTRAINT bon_livraison_prepare_receipts_bl_fkey FOREIGN KEY (bon_livraison_id) REFERENCES public.bon_livraison(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bon_livraison_prepare_receipts_actor_fkey' AND conrelid = 'public.bon_livraison_prepare_receipts'::regclass) THEN
    ALTER TABLE public.bon_livraison_prepare_receipts ADD CONSTRAINT bon_livraison_prepare_receipts_actor_fkey FOREIGN KEY (actor_user_id) REFERENCES public.users(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_reservation_verifications_reservation_fkey' AND conrelid = 'public.stock_reservation_verifications'::regclass) THEN
    ALTER TABLE public.stock_reservation_verifications ADD CONSTRAINT stock_reservation_verifications_reservation_fkey FOREIGN KEY (reservation_id) REFERENCES public.stock_reservations(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_reservation_verifications_user_fkey' AND conrelid = 'public.stock_reservation_verifications'::regclass) THEN
    ALTER TABLE public.stock_reservation_verifications ADD CONSTRAINT stock_reservation_verifications_user_fkey FOREIGN KEY (verified_by) REFERENCES public.users(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_reservation_corrections_reservation_fkey' AND conrelid = 'public.stock_reservation_corrections'::regclass) THEN
    ALTER TABLE public.stock_reservation_corrections ADD CONSTRAINT stock_reservation_corrections_reservation_fkey FOREIGN KEY (reservation_id) REFERENCES public.stock_reservations(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_reservation_corrections_user_fkey' AND conrelid = 'public.stock_reservation_corrections'::regclass) THEN
    ALTER TABLE public.stock_reservation_corrections ADD CONSTRAINT stock_reservation_corrections_user_fkey FOREIGN KEY (actor_user_id) REFERENCES public.users(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_reservation_corrections_movement_fkey' AND conrelid = 'public.stock_reservation_corrections'::regclass) THEN
    ALTER TABLE public.stock_reservation_corrections ADD CONSTRAINT stock_reservation_corrections_movement_fkey FOREIGN KEY (stock_movement_id) REFERENCES public.stock_movements(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS bon_livraison_ship_receipts_bl_idx ON public.bon_livraison_ship_receipts (bon_livraison_id, created_at DESC);
CREATE INDEX IF NOT EXISTS bon_livraison_prepare_receipts_bl_idx ON public.bon_livraison_prepare_receipts (bon_livraison_id, created_at DESC);
CREATE INDEX IF NOT EXISTS stock_reservation_verifications_reservation_idx ON public.stock_reservation_verifications (reservation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS stock_reservation_corrections_reservation_idx ON public.stock_reservation_corrections (reservation_id, created_at DESC);

COMMIT;

-- Rollback is deliberately kept in db/patches/support/: dropping these columns
-- would destroy traceability and requires explicit human approval.
