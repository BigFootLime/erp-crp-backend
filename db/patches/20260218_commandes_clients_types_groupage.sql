-- 20260218_commandes_clients_types_groupage.sql
--
-- Purpose
-- - Add professional order types to commande_client: FERME / CADRE / INTERNE
-- - Add CADRE call-offs (releases)
-- - Add Production Grouping (groupe de production) linked to Affaires and OF
-- - Add minimal fields for internal orders (destination stock)
--
-- Safety / constraints (requested)
-- - Idempotent patch (safe to run multiple times)
-- - No data loss: only CREATE / ALTER (no DROP of existing business data)
-- - Prefer nullable fields + check constraints so existing data keeps working
--
-- Target DB
-- - PostgreSQL

BEGIN;

/* -------------------------------------------------------------------------- */
/* 0) Optional extensions (best-effort)                                       */
/* -------------------------------------------------------------------------- */

DO $$
BEGIN
  BEGIN
    EXECUTE 'CREATE EXTENSION IF NOT EXISTS pgcrypto';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'Skipping CREATE EXTENSION pgcrypto (insufficient privileges)';
  END;

  BEGIN
    EXECUTE 'CREATE EXTENSION IF NOT EXISTS "uuid-ossp"';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'Skipping CREATE EXTENSION uuid-ossp (insufficient privileges)';
  END;
END $$;

/* -------------------------------------------------------------------------- */
/* 1) Commande types: FERME / CADRE / INTERNE                                 */
/* -------------------------------------------------------------------------- */

-- New order type on commande_client
ALTER TABLE public.commande_client
  ADD COLUMN IF NOT EXISTS order_type TEXT;

UPDATE public.commande_client
SET order_type = COALESCE(order_type, 'FERME')
WHERE order_type IS NULL;

ALTER TABLE public.commande_client
  ALTER COLUMN order_type SET DEFAULT 'FERME';

ALTER TABLE public.commande_client
  ALTER COLUMN order_type SET NOT NULL;

-- Internal orders must not force client selection.
ALTER TABLE public.commande_client
  ALTER COLUMN client_id DROP NOT NULL;

-- CADRE contract window
ALTER TABLE public.commande_client
  ADD COLUMN IF NOT EXISTS cadre_start_date DATE NULL;

ALTER TABLE public.commande_client
  ADD COLUMN IF NOT EXISTS cadre_end_date DATE NULL;

-- Billing address (delivery address already stored as destinataire_id)
ALTER TABLE public.commande_client
  ADD COLUMN IF NOT EXISTS adresse_facturation_id UUID NULL;

-- Internal order destination stock (requires stock module tables if present)
ALTER TABLE public.commande_client
  ADD COLUMN IF NOT EXISTS dest_stock_magasin_id BIGINT NULL;

ALTER TABLE public.commande_client
  ADD COLUMN IF NOT EXISTS dest_stock_emplacement_id BIGINT NULL;

CREATE INDEX IF NOT EXISTS commande_client_order_type_idx
  ON public.commande_client (order_type);

CREATE INDEX IF NOT EXISTS commande_client_cadre_window_idx
  ON public.commande_client (cadre_start_date, cadre_end_date)
  WHERE cadre_start_date IS NOT NULL OR cadre_end_date IS NOT NULL;

DO $$
BEGIN
  -- order_type constraint
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'commande_client_order_type_check'
      AND conrelid = 'public.commande_client'::regclass
  ) THEN
    ALTER TABLE public.commande_client
      ADD CONSTRAINT commande_client_order_type_check
      CHECK (order_type IN ('FERME', 'CADRE', 'INTERNE'));
  END IF;

  -- CADRE window constraint
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'commande_client_cadre_window_check'
      AND conrelid = 'public.commande_client'::regclass
  ) THEN
    ALTER TABLE public.commande_client
      ADD CONSTRAINT commande_client_cadre_window_check
      CHECK (
        cadre_start_date IS NULL
        OR cadre_end_date IS NULL
        OR cadre_start_date <= cadre_end_date
      );
  END IF;

  -- Destination stock FK constraints (only if stock tables exist)
  IF to_regclass('public.magasins') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'commande_client_dest_stock_magasin_id_fkey'
      AND conrelid = 'public.commande_client'::regclass
  ) THEN
    ALTER TABLE public.commande_client
      ADD CONSTRAINT commande_client_dest_stock_magasin_id_fkey
      FOREIGN KEY (dest_stock_magasin_id) REFERENCES public.magasins(id) ON DELETE SET NULL;
  END IF;

  IF to_regclass('public.emplacements') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'commande_client_dest_stock_emplacement_id_fkey'
      AND conrelid = 'public.commande_client'::regclass
  ) THEN
    ALTER TABLE public.commande_client
      ADD CONSTRAINT commande_client_dest_stock_emplacement_id_fkey
      FOREIGN KEY (dest_stock_emplacement_id) REFERENCES public.emplacements(id) ON DELETE SET NULL;
  END IF;

  -- If an INTERNAL order has a stock destination, enforce magasin is present.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'commande_client_internal_stock_dest_check'
      AND conrelid = 'public.commande_client'::regclass
  ) THEN
    ALTER TABLE public.commande_client
      ADD CONSTRAINT commande_client_internal_stock_dest_check
      CHECK (
        (order_type <> 'INTERNE')
        OR (dest_stock_magasin_id IS NOT NULL)
      );
  END IF;
END $$;

/* -------------------------------------------------------------------------- */
/* 2) CADRE call-offs (releases)                                              */
/* -------------------------------------------------------------------------- */

CREATE SEQUENCE IF NOT EXISTS public.commande_cadre_release_no_seq;

CREATE TABLE IF NOT EXISTS public.commande_cadre_release (
  id BIGSERIAL PRIMARY KEY,
  commande_cadre_id BIGINT NOT NULL,
  numero_release TEXT NOT NULL,
  date_demande DATE NOT NULL DEFAULT CURRENT_DATE,
  date_livraison_prevue DATE NULL,
  statut TEXT NOT NULL DEFAULT 'PLANNED',
  notes TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by INTEGER NULL,
  updated_by INTEGER NULL,
  CONSTRAINT commande_cadre_release_commande_fkey FOREIGN KEY (commande_cadre_id)
    REFERENCES public.commande_client(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS commande_cadre_release_unique_num
  ON public.commande_cadre_release (commande_cadre_id, numero_release);

CREATE INDEX IF NOT EXISTS commande_cadre_release_commande_idx
  ON public.commande_cadre_release (commande_cadre_id, date_demande DESC, id DESC);

CREATE INDEX IF NOT EXISTS commande_cadre_release_status_idx
  ON public.commande_cadre_release (statut);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'commande_cadre_release_status_check'
      AND conrelid = 'public.commande_cadre_release'::regclass
  ) THEN
    ALTER TABLE public.commande_cadre_release
      ADD CONSTRAINT commande_cadre_release_status_check
      CHECK (statut IN ('PLANNED', 'SENT', 'CONFIRMED', 'DELIVERED', 'CANCELLED'));
  END IF;

  IF to_regclass('public.users') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'commande_cadre_release_created_by_fkey'
      AND conrelid = 'public.commande_cadre_release'::regclass
  ) THEN
    ALTER TABLE public.commande_cadre_release
      ADD CONSTRAINT commande_cadre_release_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;

  IF to_regclass('public.users') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'commande_cadre_release_updated_by_fkey'
      AND conrelid = 'public.commande_cadre_release'::regclass
  ) THEN
    ALTER TABLE public.commande_cadre_release
      ADD CONSTRAINT commande_cadre_release_updated_by_fkey
      FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;

  IF to_regproc('public.tg_set_updated_at()') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS commande_cadre_release_set_updated_at ON public.commande_cadre_release';
    EXECUTE 'CREATE TRIGGER commande_cadre_release_set_updated_at BEFORE UPDATE ON public.commande_cadre_release FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at()';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.commande_cadre_release_ligne (
  id BIGSERIAL PRIMARY KEY,
  release_id BIGINT NOT NULL,
  ordre INTEGER NOT NULL DEFAULT 1,
  commande_ligne_id BIGINT NULL,
  designation TEXT NOT NULL,
  code_piece TEXT NULL,
  quantite NUMERIC(18,3) NOT NULL,
  unite TEXT NULL,
  delai_client TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by INTEGER NULL,
  updated_by INTEGER NULL,
  CONSTRAINT commande_cadre_release_ligne_release_fkey FOREIGN KEY (release_id)
    REFERENCES public.commande_cadre_release(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS commande_cadre_release_ligne_release_idx
  ON public.commande_cadre_release_ligne (release_id, ordre ASC, id ASC);

CREATE INDEX IF NOT EXISTS commande_cadre_release_ligne_commande_ligne_idx
  ON public.commande_cadre_release_ligne (commande_ligne_id)
  WHERE commande_ligne_id IS NOT NULL;

DO $$
BEGIN
  IF to_regclass('public.commande_ligne') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'commande_cadre_release_ligne_commande_ligne_id_fkey'
      AND conrelid = 'public.commande_cadre_release_ligne'::regclass
  ) THEN
    ALTER TABLE public.commande_cadre_release_ligne
      ADD CONSTRAINT commande_cadre_release_ligne_commande_ligne_id_fkey
      FOREIGN KEY (commande_ligne_id) REFERENCES public.commande_ligne(id) ON DELETE SET NULL;
  END IF;

  IF to_regclass('public.users') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'commande_cadre_release_ligne_created_by_fkey'
      AND conrelid = 'public.commande_cadre_release_ligne'::regclass
  ) THEN
    ALTER TABLE public.commande_cadre_release_ligne
      ADD CONSTRAINT commande_cadre_release_ligne_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;

  IF to_regclass('public.users') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'commande_cadre_release_ligne_updated_by_fkey'
      AND conrelid = 'public.commande_cadre_release_ligne'::regclass
  ) THEN
    ALTER TABLE public.commande_cadre_release_ligne
      ADD CONSTRAINT commande_cadre_release_ligne_updated_by_fkey
      FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'commande_cadre_release_ligne_qty_check'
      AND conrelid = 'public.commande_cadre_release_ligne'::regclass
  ) THEN
    ALTER TABLE public.commande_cadre_release_ligne
      ADD CONSTRAINT commande_cadre_release_ligne_qty_check
      CHECK (quantite > 0);
  END IF;

  IF to_regproc('public.tg_set_updated_at()') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS commande_cadre_release_ligne_set_updated_at ON public.commande_cadre_release_ligne';
    EXECUTE 'CREATE TRIGGER commande_cadre_release_ligne_set_updated_at BEFORE UPDATE ON public.commande_cadre_release_ligne FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at()';
  END IF;
END $$;

-- Optional linkage for traceability: Affaire can reference a specific CADRE release.
ALTER TABLE public.affaire
  ADD COLUMN IF NOT EXISTS commande_cadre_release_id BIGINT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'affaire_commande_cadre_release_id_fkey'
      AND conrelid = 'public.affaire'::regclass
  ) THEN
    ALTER TABLE public.affaire
      ADD CONSTRAINT affaire_commande_cadre_release_id_fkey
      FOREIGN KEY (commande_cadre_release_id) REFERENCES public.commande_cadre_release(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS affaire_commande_cadre_release_idx
  ON public.affaire (commande_cadre_release_id)
  WHERE commande_cadre_release_id IS NOT NULL;

/* -------------------------------------------------------------------------- */
/* 3) Production Group (groupe de production)                                 */
/* -------------------------------------------------------------------------- */

CREATE SEQUENCE IF NOT EXISTS public.production_group_code_seq;

CREATE TABLE IF NOT EXISTS public.production_group (
  id UUID PRIMARY KEY,
  code TEXT NOT NULL,
  client_id TEXT NULL,
  piece_technique_id UUID NULL,
  piece_code TEXT NULL,
  piece_label TEXT NULL,
  description TEXT NULL,
  notes TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by INTEGER NULL,
  updated_by INTEGER NULL
);

DO $$
BEGIN
  IF to_regproc('gen_random_uuid()') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.production_group ALTER COLUMN id SET DEFAULT gen_random_uuid()';
  ELSIF to_regproc('uuid_generate_v4()') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.production_group ALTER COLUMN id SET DEFAULT uuid_generate_v4()';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'production_group_code_uniq'
      AND conrelid = 'public.production_group'::regclass
  ) THEN
    ALTER TABLE public.production_group
      ADD CONSTRAINT production_group_code_uniq UNIQUE (code);
  END IF;

  IF to_regclass('public.clients') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'production_group_client_id_fkey'
      AND conrelid = 'public.production_group'::regclass
  ) THEN
    ALTER TABLE public.production_group
      ADD CONSTRAINT production_group_client_id_fkey
      FOREIGN KEY (client_id) REFERENCES public.clients(client_id) ON DELETE SET NULL;
  END IF;

  IF to_regclass('public.pieces_techniques') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'production_group_piece_technique_id_fkey'
      AND conrelid = 'public.production_group'::regclass
  ) THEN
    ALTER TABLE public.production_group
      ADD CONSTRAINT production_group_piece_technique_id_fkey
      FOREIGN KEY (piece_technique_id) REFERENCES public.pieces_techniques(id) ON DELETE SET NULL;
  END IF;

  IF to_regclass('public.users') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'production_group_created_by_fkey'
      AND conrelid = 'public.production_group'::regclass
  ) THEN
    ALTER TABLE public.production_group
      ADD CONSTRAINT production_group_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;

  IF to_regclass('public.users') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'production_group_updated_by_fkey'
      AND conrelid = 'public.production_group'::regclass
  ) THEN
    ALTER TABLE public.production_group
      ADD CONSTRAINT production_group_updated_by_fkey
      FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;

  IF to_regproc('public.tg_set_updated_at()') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS production_group_set_updated_at ON public.production_group';
    EXECUTE 'CREATE TRIGGER production_group_set_updated_at BEFORE UPDATE ON public.production_group FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at()';
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS production_group_client_idx
  ON public.production_group (client_id)
  WHERE client_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS production_group_piece_idx
  ON public.production_group (piece_technique_id)
  WHERE piece_technique_id IS NOT NULL;

-- Link to Affaires (one affaire can belong to at most one group)
ALTER TABLE public.affaire
  ADD COLUMN IF NOT EXISTS production_group_id UUID NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'affaire_production_group_id_fkey'
      AND conrelid = 'public.affaire'::regclass
  ) THEN
    ALTER TABLE public.affaire
      ADD CONSTRAINT affaire_production_group_id_fkey
      FOREIGN KEY (production_group_id) REFERENCES public.production_group(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS affaire_production_group_idx
  ON public.affaire (production_group_id)
  WHERE production_group_id IS NOT NULL;

-- Link to OF (ordres_fabrication)
ALTER TABLE public.ordres_fabrication
  ADD COLUMN IF NOT EXISTS production_group_id UUID NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ordres_fabrication_production_group_id_fkey'
      AND conrelid = 'public.ordres_fabrication'::regclass
  ) THEN
    ALTER TABLE public.ordres_fabrication
      ADD CONSTRAINT ordres_fabrication_production_group_id_fkey
      FOREIGN KEY (production_group_id) REFERENCES public.production_group(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS ordres_fabrication_production_group_idx
  ON public.ordres_fabrication (production_group_id)
  WHERE production_group_id IS NOT NULL;

COMMIT;
