-- 20260226_qualite_complete_ncr_capa_stock.sql
-- Phase 12: Qualite complet (NC + CAPA + Dispositions + Liaison stock)
-- Idempotent patch: safe to run multiple times.

BEGIN;

/* -------------------------------------------------------------------------- */
/* 0) Optional extensions                                                     */
/* -------------------------------------------------------------------------- */

DO $$
BEGIN
  -- Commonly used for gen_random_uuid(). If already installed, this is a no-op.
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'Skipping extension pgcrypto (insufficient_privilege)';
END $$;

/* -------------------------------------------------------------------------- */
/* 1) Lots: allow QUARANTAINE                                                 */
/* -------------------------------------------------------------------------- */

DO $$
BEGIN
  IF to_regclass('public.lots') IS NULL THEN
    RAISE NOTICE 'Skipping lots status constraint (public.lots missing)';
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'lots_lot_status_check'
      AND conrelid = 'public.lots'::regclass
  ) THEN
    ALTER TABLE public.lots DROP CONSTRAINT lots_lot_status_check;
  END IF;

  -- Keep legacy EN_ATTENTE while introducing QUARANTAINE.
  ALTER TABLE public.lots
    ADD CONSTRAINT lots_lot_status_check
    CHECK (lot_status IN ('LIBERE', 'BLOQUE', 'EN_ATTENTE', 'QUARANTAINE'))
    NOT VALID;

  ALTER TABLE public.lots VALIDATE CONSTRAINT lots_lot_status_check;
END $$;

/* -------------------------------------------------------------------------- */
/* 2) Non-conformities: context links + lifecycle fields                       */
/* -------------------------------------------------------------------------- */

ALTER TABLE public.non_conformity
  ADD COLUMN IF NOT EXISTS lot_id uuid NULL,
  ADD COLUMN IF NOT EXISTS bon_livraison_id uuid NULL,
  ADD COLUMN IF NOT EXISTS reception_ligne_id uuid NULL,
  ADD COLUMN IF NOT EXISTS fournisseur_id uuid NULL,
  ADD COLUMN IF NOT EXISTS of_operation_id uuid NULL,
  ADD COLUMN IF NOT EXISTS piece_technique_operation_id uuid NULL,
  ADD COLUMN IF NOT EXISTS containment_action text NULL,
  ADD COLUMN IF NOT EXISTS correction_action text NULL,
  ADD COLUMN IF NOT EXISTS due_date date NULL,
  ADD COLUMN IF NOT EXISTS closed_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS closed_by integer NULL;

CREATE INDEX IF NOT EXISTS non_conformity_lot_id_idx ON public.non_conformity (lot_id);
CREATE INDEX IF NOT EXISTS non_conformity_bon_livraison_id_idx ON public.non_conformity (bon_livraison_id);
CREATE INDEX IF NOT EXISTS non_conformity_reception_ligne_id_idx ON public.non_conformity (reception_ligne_id);
CREATE INDEX IF NOT EXISTS non_conformity_fournisseur_id_idx ON public.non_conformity (fournisseur_id);
CREATE INDEX IF NOT EXISTS non_conformity_of_operation_id_idx ON public.non_conformity (of_operation_id);
CREATE INDEX IF NOT EXISTS non_conformity_piece_technique_operation_id_idx ON public.non_conformity (piece_technique_operation_id);
CREATE INDEX IF NOT EXISTS non_conformity_due_date_idx ON public.non_conformity (due_date);

DO $$
BEGIN
  -- Add FK to public.lots only when the PK type is UUID.
  IF to_regclass('public.lots') IS NOT NULL AND EXISTS (
    SELECT 1
    FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND c.table_name = 'lots'
      AND c.column_name = 'id'
      AND c.data_type = 'uuid'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'non_conformity_lot_fkey'
      AND conrelid = 'public.non_conformity'::regclass
  ) THEN
    ALTER TABLE public.non_conformity
      ADD CONSTRAINT non_conformity_lot_fkey
      FOREIGN KEY (lot_id) REFERENCES public.lots(id) ON DELETE SET NULL;
  END IF;

  IF to_regclass('public.bon_livraison') IS NOT NULL AND EXISTS (
    SELECT 1
    FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND c.table_name = 'bon_livraison'
      AND c.column_name = 'id'
      AND c.data_type = 'uuid'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'non_conformity_bon_livraison_fkey'
      AND conrelid = 'public.non_conformity'::regclass
  ) THEN
    ALTER TABLE public.non_conformity
      ADD CONSTRAINT non_conformity_bon_livraison_fkey
      FOREIGN KEY (bon_livraison_id) REFERENCES public.bon_livraison(id) ON DELETE SET NULL;
  END IF;

  IF to_regclass('public.reception_fournisseur_lignes') IS NOT NULL AND EXISTS (
    SELECT 1
    FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND c.table_name = 'reception_fournisseur_lignes'
      AND c.column_name = 'id'
      AND c.data_type = 'uuid'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'non_conformity_reception_ligne_fkey'
      AND conrelid = 'public.non_conformity'::regclass
  ) THEN
    ALTER TABLE public.non_conformity
      ADD CONSTRAINT non_conformity_reception_ligne_fkey
      FOREIGN KEY (reception_ligne_id) REFERENCES public.reception_fournisseur_lignes(id) ON DELETE SET NULL;
  END IF;

  IF to_regclass('public.fournisseurs') IS NOT NULL AND EXISTS (
    SELECT 1
    FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND c.table_name = 'fournisseurs'
      AND c.column_name = 'id'
      AND c.data_type = 'uuid'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'non_conformity_fournisseur_fkey'
      AND conrelid = 'public.non_conformity'::regclass
  ) THEN
    ALTER TABLE public.non_conformity
      ADD CONSTRAINT non_conformity_fournisseur_fkey
      FOREIGN KEY (fournisseur_id) REFERENCES public.fournisseurs(id) ON DELETE SET NULL;
  END IF;

  IF to_regclass('public.of_operations') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'non_conformity_of_operation_fkey'
      AND conrelid = 'public.non_conformity'::regclass
  ) THEN
    ALTER TABLE public.non_conformity
      ADD CONSTRAINT non_conformity_of_operation_fkey
      FOREIGN KEY (of_operation_id) REFERENCES public.of_operations(id) ON DELETE SET NULL;
  END IF;
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'Skipping some non_conformity foreign keys (missing tables)';
END $$;

DO $$
BEGIN
  IF to_regclass('public.users') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'non_conformity_closed_by_fkey'
      AND conrelid = 'public.non_conformity'::regclass
  ) THEN
    ALTER TABLE public.non_conformity
      ADD CONSTRAINT non_conformity_closed_by_fkey
      FOREIGN KEY (closed_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $$;

/* -------------------------------------------------------------------------- */
/* 3) Dispositions                                                             */
/* -------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS public.non_conformity_dispositions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  non_conformity_id uuid NOT NULL
    REFERENCES public.non_conformity(id) ON UPDATE RESTRICT ON DELETE CASCADE,

  disposition_type text NOT NULL,
  qty numeric(18, 3) NULL,
  unite text NULL,
  comment text NULL,

  decided_by integer NULL
    REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE SET NULL,
  decided_at timestamptz NOT NULL DEFAULT now(),

  stock_movement_id uuid NULL,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by integer NULL
    REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE SET NULL,
  updated_by integer NULL
    REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS non_conformity_dispositions_nc_id_idx
  ON public.non_conformity_dispositions (non_conformity_id);
CREATE INDEX IF NOT EXISTS non_conformity_dispositions_decided_at_idx
  ON public.non_conformity_dispositions (decided_at);
CREATE INDEX IF NOT EXISTS non_conformity_dispositions_stock_movement_id_idx
  ON public.non_conformity_dispositions (stock_movement_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'non_conformity_dispositions_type_check'
      AND conrelid = 'public.non_conformity_dispositions'::regclass
  ) THEN
    ALTER TABLE public.non_conformity_dispositions
      ADD CONSTRAINT non_conformity_dispositions_type_check
      CHECK (disposition_type IN (
        'HOLD',
        'RELEASE',
        'USE_AS_IS',
        'REWORK',
        'SORT',
        'SCRAP',
        'RETURN_SUPPLIER'
      ));
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.stock_movements') IS NOT NULL AND EXISTS (
    SELECT 1
    FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND c.table_name = 'stock_movements'
      AND c.column_name = 'id'
      AND c.data_type = 'uuid'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'non_conformity_dispositions_stock_movement_fkey'
      AND conrelid = 'public.non_conformity_dispositions'::regclass
  ) THEN
    ALTER TABLE public.non_conformity_dispositions
      ADD CONSTRAINT non_conformity_dispositions_stock_movement_fkey
      FOREIGN KEY (stock_movement_id) REFERENCES public.stock_movements(id) ON DELETE SET NULL;
  END IF;
EXCEPTION
  WHEN undefined_table THEN
    RAISE NOTICE 'Skipping stock movement FK (public.stock_movements missing)';
END $$;

COMMIT;
