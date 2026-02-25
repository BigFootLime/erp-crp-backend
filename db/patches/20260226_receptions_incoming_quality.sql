-- 20260226_receptions_incoming_quality.sql
-- Phase 9: Reception & Qualite fournisseur
-- - Receptions fournisseur + lignes
-- - Documents (certificat matiere EN 10204 3.1, etc.)
-- - Incoming inspection + mesures + decision (LIBERE/BLOQUE)
-- - Lot status on public.lots
--
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
/* 1) Lots: qualite status                                                    */
/* -------------------------------------------------------------------------- */

-- Existing lots should remain usable by default.
ALTER TABLE public.lots
  ADD COLUMN IF NOT EXISTS lot_status text NOT NULL DEFAULT 'LIBERE';

ALTER TABLE public.lots
  ADD COLUMN IF NOT EXISTS lot_status_note text NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'lots_lot_status_check'
      AND conrelid = 'public.lots'::regclass
  ) THEN
    ALTER TABLE public.lots
      ADD CONSTRAINT lots_lot_status_check
      CHECK (lot_status IN ('LIBERE', 'BLOQUE', 'EN_ATTENTE'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS lots_lot_status_idx ON public.lots (lot_status);

/* -------------------------------------------------------------------------- */
/* 2) Receptions fournisseur                                                  */
/* -------------------------------------------------------------------------- */

CREATE SEQUENCE IF NOT EXISTS public.reception_fournisseur_no_seq;

CREATE TABLE IF NOT EXISTS public.receptions_fournisseurs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reception_no text NOT NULL,
  fournisseur_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'OPEN',
  reception_date date NOT NULL DEFAULT CURRENT_DATE,
  supplier_reference text NULL,
  commentaire text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by integer NULL,
  updated_by integer NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS receptions_fournisseurs_reception_no_uniq
  ON public.receptions_fournisseurs (reception_no);

CREATE INDEX IF NOT EXISTS receptions_fournisseurs_fournisseur_idx
  ON public.receptions_fournisseurs (fournisseur_id);

CREATE INDEX IF NOT EXISTS receptions_fournisseurs_status_idx
  ON public.receptions_fournisseurs (status);

CREATE INDEX IF NOT EXISTS receptions_fournisseurs_date_idx
  ON public.receptions_fournisseurs (reception_date);

CREATE INDEX IF NOT EXISTS receptions_fournisseurs_updated_at_idx
  ON public.receptions_fournisseurs (updated_at);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'receptions_fournisseurs_status_check'
      AND conrelid = 'public.receptions_fournisseurs'::regclass
  ) THEN
    ALTER TABLE public.receptions_fournisseurs
      ADD CONSTRAINT receptions_fournisseurs_status_check
      CHECK (status IN ('OPEN', 'CLOSED', 'CANCELLED'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'receptions_fournisseurs_fournisseur_fkey'
      AND conrelid = 'public.receptions_fournisseurs'::regclass
  ) THEN
    ALTER TABLE public.receptions_fournisseurs
      ADD CONSTRAINT receptions_fournisseurs_fournisseur_fkey
      FOREIGN KEY (fournisseur_id) REFERENCES public.fournisseurs(id) ON DELETE RESTRICT;
  END IF;

  IF to_regclass('public.users') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'receptions_fournisseurs_created_by_fkey'
      AND conrelid = 'public.receptions_fournisseurs'::regclass
  ) THEN
    ALTER TABLE public.receptions_fournisseurs
      ADD CONSTRAINT receptions_fournisseurs_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;

  IF to_regclass('public.users') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'receptions_fournisseurs_updated_by_fkey'
      AND conrelid = 'public.receptions_fournisseurs'::regclass
  ) THEN
    ALTER TABLE public.receptions_fournisseurs
      ADD CONSTRAINT receptions_fournisseurs_updated_by_fkey
      FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $$;

/* -------------------------------------------------------------------------- */
/* 3) Lignes                                                                  */
/* -------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS public.reception_fournisseur_lignes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reception_id uuid NOT NULL,
  line_no integer NOT NULL,
  article_id uuid NOT NULL,
  designation text NULL,
  qty_received numeric(18, 3) NOT NULL,
  unite text NULL,
  supplier_lot_code text NULL,
  lot_id uuid NULL,
  notes text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by integer NULL,
  updated_by integer NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS reception_fournisseur_lignes_key_uniq
  ON public.reception_fournisseur_lignes (reception_id, line_no);

CREATE INDEX IF NOT EXISTS reception_fournisseur_lignes_reception_idx
  ON public.reception_fournisseur_lignes (reception_id);

CREATE INDEX IF NOT EXISTS reception_fournisseur_lignes_article_idx
  ON public.reception_fournisseur_lignes (article_id);

CREATE INDEX IF NOT EXISTS reception_fournisseur_lignes_lot_idx
  ON public.reception_fournisseur_lignes (lot_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'reception_fournisseur_lignes_reception_fkey'
      AND conrelid = 'public.reception_fournisseur_lignes'::regclass
  ) THEN
    ALTER TABLE public.reception_fournisseur_lignes
      ADD CONSTRAINT reception_fournisseur_lignes_reception_fkey
      FOREIGN KEY (reception_id) REFERENCES public.receptions_fournisseurs(id) ON DELETE CASCADE;
  END IF;

  -- Add FK to public.articles only when the PK type is UUID.
  IF to_regclass('public.articles') IS NOT NULL AND EXISTS (
    SELECT 1
    FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND c.table_name = 'articles'
      AND c.column_name = 'id'
      AND c.data_type = 'uuid'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'reception_fournisseur_lignes_article_fkey'
      AND conrelid = 'public.reception_fournisseur_lignes'::regclass
  ) THEN
    ALTER TABLE public.reception_fournisseur_lignes
      ADD CONSTRAINT reception_fournisseur_lignes_article_fkey
      FOREIGN KEY (article_id) REFERENCES public.articles(id) ON DELETE RESTRICT;
  END IF;

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
    WHERE conname = 'reception_fournisseur_lignes_lot_fkey'
      AND conrelid = 'public.reception_fournisseur_lignes'::regclass
  ) THEN
    ALTER TABLE public.reception_fournisseur_lignes
      ADD CONSTRAINT reception_fournisseur_lignes_lot_fkey
      FOREIGN KEY (lot_id) REFERENCES public.lots(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'reception_fournisseur_lignes_qty_nonneg_chk'
      AND conrelid = 'public.reception_fournisseur_lignes'::regclass
  ) THEN
    ALTER TABLE public.reception_fournisseur_lignes
      ADD CONSTRAINT reception_fournisseur_lignes_qty_nonneg_chk
      CHECK (qty_received >= 0);
  END IF;

  IF to_regclass('public.users') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'reception_fournisseur_lignes_created_by_fkey'
      AND conrelid = 'public.reception_fournisseur_lignes'::regclass
  ) THEN
    ALTER TABLE public.reception_fournisseur_lignes
      ADD CONSTRAINT reception_fournisseur_lignes_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;

  IF to_regclass('public.users') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'reception_fournisseur_lignes_updated_by_fkey'
      AND conrelid = 'public.reception_fournisseur_lignes'::regclass
  ) THEN
    ALTER TABLE public.reception_fournisseur_lignes
      ADD CONSTRAINT reception_fournisseur_lignes_updated_by_fkey
      FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $$;

/* -------------------------------------------------------------------------- */
/* 4) Documents                                                               */
/* -------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS public.reception_fournisseur_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reception_id uuid NOT NULL,
  reception_line_id uuid NULL,
  document_type text NOT NULL,
  commentaire text NULL,
  original_name text NOT NULL,
  stored_name text NOT NULL,
  storage_path text NOT NULL,
  mime_type text NOT NULL,
  size_bytes bigint NOT NULL,
  sha256 text NULL,
  label text NULL,
  uploaded_by integer NULL,
  removed_at timestamptz NULL,
  removed_by integer NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by integer NULL,
  updated_by integer NULL,
  CONSTRAINT reception_fournisseur_documents_size_nonneg_chk CHECK (size_bytes >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS reception_fournisseur_documents_storage_path_uniq
  ON public.reception_fournisseur_documents (storage_path);

CREATE INDEX IF NOT EXISTS reception_fournisseur_documents_reception_idx
  ON public.reception_fournisseur_documents (reception_id);

CREATE INDEX IF NOT EXISTS reception_fournisseur_documents_active_idx
  ON public.reception_fournisseur_documents (reception_id)
  WHERE removed_at IS NULL;

CREATE INDEX IF NOT EXISTS reception_fournisseur_documents_type_idx
  ON public.reception_fournisseur_documents (document_type);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'reception_fournisseur_documents_type_check'
      AND conrelid = 'public.reception_fournisseur_documents'::regclass
  ) THEN
    ALTER TABLE public.reception_fournisseur_documents
      ADD CONSTRAINT reception_fournisseur_documents_type_check
      CHECK (document_type IN ('CERTIFICAT_MATIERE', 'BON_LIVRAISON', 'AUTRE'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'reception_fournisseur_documents_reception_fkey'
      AND conrelid = 'public.reception_fournisseur_documents'::regclass
  ) THEN
    ALTER TABLE public.reception_fournisseur_documents
      ADD CONSTRAINT reception_fournisseur_documents_reception_fkey
      FOREIGN KEY (reception_id) REFERENCES public.receptions_fournisseurs(id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'reception_fournisseur_documents_line_fkey'
      AND conrelid = 'public.reception_fournisseur_documents'::regclass
  ) THEN
    ALTER TABLE public.reception_fournisseur_documents
      ADD CONSTRAINT reception_fournisseur_documents_line_fkey
      FOREIGN KEY (reception_line_id) REFERENCES public.reception_fournisseur_lignes(id) ON DELETE SET NULL;
  END IF;

  IF to_regclass('public.users') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'reception_fournisseur_documents_created_by_fkey'
      AND conrelid = 'public.reception_fournisseur_documents'::regclass
  ) THEN
    ALTER TABLE public.reception_fournisseur_documents
      ADD CONSTRAINT reception_fournisseur_documents_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;

  IF to_regclass('public.users') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'reception_fournisseur_documents_updated_by_fkey'
      AND conrelid = 'public.reception_fournisseur_documents'::regclass
  ) THEN
    ALTER TABLE public.reception_fournisseur_documents
      ADD CONSTRAINT reception_fournisseur_documents_updated_by_fkey
      FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;

  IF to_regclass('public.users') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'reception_fournisseur_documents_removed_by_fkey'
      AND conrelid = 'public.reception_fournisseur_documents'::regclass
  ) THEN
    ALTER TABLE public.reception_fournisseur_documents
      ADD CONSTRAINT reception_fournisseur_documents_removed_by_fkey
      FOREIGN KEY (removed_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $$;

/* -------------------------------------------------------------------------- */
/* 5) Incoming inspection                                                     */
/* -------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS public.reception_incoming_inspections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reception_id uuid NOT NULL,
  reception_line_id uuid NOT NULL,
  lot_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'IN_PROGRESS',
  decision text NULL,
  decision_note text NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz NULL,
  decided_by integer NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by integer NULL,
  updated_by integer NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS reception_incoming_inspections_line_uniq
  ON public.reception_incoming_inspections (reception_line_id);

CREATE INDEX IF NOT EXISTS reception_incoming_inspections_reception_idx
  ON public.reception_incoming_inspections (reception_id);

CREATE INDEX IF NOT EXISTS reception_incoming_inspections_lot_idx
  ON public.reception_incoming_inspections (lot_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'reception_incoming_inspections_status_check'
      AND conrelid = 'public.reception_incoming_inspections'::regclass
  ) THEN
    ALTER TABLE public.reception_incoming_inspections
      ADD CONSTRAINT reception_incoming_inspections_status_check
      CHECK (status IN ('IN_PROGRESS', 'DECIDED'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'reception_incoming_inspections_decision_check'
      AND conrelid = 'public.reception_incoming_inspections'::regclass
  ) THEN
    ALTER TABLE public.reception_incoming_inspections
      ADD CONSTRAINT reception_incoming_inspections_decision_check
      CHECK (decision IS NULL OR decision IN ('LIBERE', 'BLOQUE'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'reception_incoming_inspections_reception_fkey'
      AND conrelid = 'public.reception_incoming_inspections'::regclass
  ) THEN
    ALTER TABLE public.reception_incoming_inspections
      ADD CONSTRAINT reception_incoming_inspections_reception_fkey
      FOREIGN KEY (reception_id) REFERENCES public.receptions_fournisseurs(id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'reception_incoming_inspections_line_fkey'
      AND conrelid = 'public.reception_incoming_inspections'::regclass
  ) THEN
    ALTER TABLE public.reception_incoming_inspections
      ADD CONSTRAINT reception_incoming_inspections_line_fkey
      FOREIGN KEY (reception_line_id) REFERENCES public.reception_fournisseur_lignes(id) ON DELETE CASCADE;
  END IF;

  IF to_regclass('public.lots') IS NOT NULL AND EXISTS (
    SELECT 1
    FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND c.table_name = 'lots'
      AND c.column_name = 'id'
      AND c.data_type = 'uuid'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'reception_incoming_inspections_lot_fkey'
      AND conrelid = 'public.reception_incoming_inspections'::regclass
  ) THEN
    ALTER TABLE public.reception_incoming_inspections
      ADD CONSTRAINT reception_incoming_inspections_lot_fkey
      FOREIGN KEY (lot_id) REFERENCES public.lots(id) ON DELETE RESTRICT;
  END IF;

  IF to_regclass('public.users') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'reception_incoming_inspections_decided_by_fkey'
      AND conrelid = 'public.reception_incoming_inspections'::regclass
  ) THEN
    ALTER TABLE public.reception_incoming_inspections
      ADD CONSTRAINT reception_incoming_inspections_decided_by_fkey
      FOREIGN KEY (decided_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.reception_incoming_measurements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inspection_id uuid NOT NULL,
  characteristic text NOT NULL,
  nominal_value numeric NULL,
  tolerance_min numeric NULL,
  tolerance_max numeric NULL,
  measured_value numeric NULL,
  unit text NULL,
  result text NULL,
  comment text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by integer NULL,
  updated_by integer NULL
);

CREATE INDEX IF NOT EXISTS reception_incoming_measurements_inspection_idx
  ON public.reception_incoming_measurements (inspection_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'reception_incoming_measurements_result_check'
      AND conrelid = 'public.reception_incoming_measurements'::regclass
  ) THEN
    ALTER TABLE public.reception_incoming_measurements
      ADD CONSTRAINT reception_incoming_measurements_result_check
      CHECK (result IS NULL OR result IN ('OK', 'NOK'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'reception_incoming_measurements_inspection_fkey'
      AND conrelid = 'public.reception_incoming_measurements'::regclass
  ) THEN
    ALTER TABLE public.reception_incoming_measurements
      ADD CONSTRAINT reception_incoming_measurements_inspection_fkey
      FOREIGN KEY (inspection_id) REFERENCES public.reception_incoming_inspections(id) ON DELETE CASCADE;
  END IF;
END $$;

/* -------------------------------------------------------------------------- */
/* 6) Stock receipts link                                                     */
/* -------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS public.reception_fournisseur_stock_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reception_id uuid NOT NULL,
  reception_line_id uuid NOT NULL,
  stock_movement_id uuid NOT NULL,
  qty numeric(18, 3) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by integer NULL,
  CONSTRAINT reception_fournisseur_stock_receipts_qty_nonneg_chk CHECK (qty >= 0)
);

CREATE INDEX IF NOT EXISTS reception_fournisseur_stock_receipts_reception_idx
  ON public.reception_fournisseur_stock_receipts (reception_id);

CREATE INDEX IF NOT EXISTS reception_fournisseur_stock_receipts_line_idx
  ON public.reception_fournisseur_stock_receipts (reception_line_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'reception_fournisseur_stock_receipts_reception_fkey'
      AND conrelid = 'public.reception_fournisseur_stock_receipts'::regclass
  ) THEN
    ALTER TABLE public.reception_fournisseur_stock_receipts
      ADD CONSTRAINT reception_fournisseur_stock_receipts_reception_fkey
      FOREIGN KEY (reception_id) REFERENCES public.receptions_fournisseurs(id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'reception_fournisseur_stock_receipts_line_fkey'
      AND conrelid = 'public.reception_fournisseur_stock_receipts'::regclass
  ) THEN
    ALTER TABLE public.reception_fournisseur_stock_receipts
      ADD CONSTRAINT reception_fournisseur_stock_receipts_line_fkey
      FOREIGN KEY (reception_line_id) REFERENCES public.reception_fournisseur_lignes(id) ON DELETE CASCADE;
  END IF;

  -- Add FK to public.stock_movements only when the PK type is UUID.
  IF to_regclass('public.stock_movements') IS NOT NULL AND EXISTS (
    SELECT 1
    FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND c.table_name = 'stock_movements'
      AND c.column_name = 'id'
      AND c.data_type = 'uuid'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'reception_fournisseur_stock_receipts_movement_fkey'
      AND conrelid = 'public.reception_fournisseur_stock_receipts'::regclass
  ) THEN
    ALTER TABLE public.reception_fournisseur_stock_receipts
      ADD CONSTRAINT reception_fournisseur_stock_receipts_movement_fkey
      FOREIGN KEY (stock_movement_id) REFERENCES public.stock_movements(id) ON DELETE RESTRICT;
  END IF;

  IF to_regclass('public.users') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'reception_fournisseur_stock_receipts_created_by_fkey'
      AND conrelid = 'public.reception_fournisseur_stock_receipts'::regclass
  ) THEN
    ALTER TABLE public.reception_fournisseur_stock_receipts
      ADD CONSTRAINT reception_fournisseur_stock_receipts_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $$;

COMMIT;
