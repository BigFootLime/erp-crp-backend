-- Issue #55 - Arborescence de fabrication recursive et OF parent/enfant
-- Migration additive uniquement : conserve les tables historiques et ajoute
-- la trace d'execution necessaire aux generations recursives d'OF.

DO $$
BEGIN
  EXECUTE 'CREATE EXTENSION IF NOT EXISTS pgcrypto';
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'Skipping CREATE EXTENSION pgcrypto (insufficient privileges)';
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'pieces_techniques_nomenclature_no_self_parent_ck'
      AND conrelid = 'public.pieces_techniques_nomenclature'::regclass
  ) THEN
    ALTER TABLE public.pieces_techniques_nomenclature
      ADD CONSTRAINT pieces_techniques_nomenclature_no_self_parent_ck
      CHECK (parent_piece_technique_id <> child_piece_technique_id);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.of_generation_batches
(
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  source_type text NOT NULL DEFAULT 'COMMANDE_CLIENT',
  commande_id bigint NULL,
  commande_ligne_id bigint NULL,
  root_of_id bigint NULL,
  root_piece_technique_id uuid NOT NULL,
  requested_qty numeric(12, 3) NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  created_by integer NULL,
  CONSTRAINT of_generation_batches_pkey PRIMARY KEY (id),
  CONSTRAINT of_generation_batches_requested_qty_ck CHECK (requested_qty > 0)
);

ALTER TABLE public.ordres_fabrication
  ADD COLUMN IF NOT EXISTS parent_of_id bigint NULL,
  ADD COLUMN IF NOT EXISTS root_of_id bigint NULL,
  ADD COLUMN IF NOT EXISTS generation_batch_id uuid NULL,
  ADD COLUMN IF NOT EXISTS generation_level integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS source_bom_line_id uuid NULL,
  ADD COLUMN IF NOT EXISTS structure_path text NULL,
  ADD COLUMN IF NOT EXISTS quantity_per_parent numeric(12, 3) NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS quantity_cumulative numeric(12, 3) NOT NULL DEFAULT 1;

UPDATE public.ordres_fabrication
SET root_of_id = id
WHERE root_of_id IS NULL;

UPDATE public.ordres_fabrication
SET structure_path = id::text
WHERE structure_path IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ordres_fabrication_parent_of_id_fkey'
      AND conrelid = 'public.ordres_fabrication'::regclass
  ) THEN
    ALTER TABLE public.ordres_fabrication
      ADD CONSTRAINT ordres_fabrication_parent_of_id_fkey
      FOREIGN KEY (parent_of_id) REFERENCES public.ordres_fabrication(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ordres_fabrication_root_of_id_fkey'
      AND conrelid = 'public.ordres_fabrication'::regclass
  ) THEN
    ALTER TABLE public.ordres_fabrication
      ADD CONSTRAINT ordres_fabrication_root_of_id_fkey
      FOREIGN KEY (root_of_id) REFERENCES public.ordres_fabrication(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ordres_fabrication_generation_batch_id_fkey'
      AND conrelid = 'public.ordres_fabrication'::regclass
  ) THEN
    ALTER TABLE public.ordres_fabrication
      ADD CONSTRAINT ordres_fabrication_generation_batch_id_fkey
      FOREIGN KEY (generation_batch_id) REFERENCES public.of_generation_batches(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ordres_fabrication_source_bom_line_id_fkey'
      AND conrelid = 'public.ordres_fabrication'::regclass
  ) THEN
    ALTER TABLE public.ordres_fabrication
      ADD CONSTRAINT ordres_fabrication_source_bom_line_id_fkey
      FOREIGN KEY (source_bom_line_id) REFERENCES public.pieces_techniques_nomenclature(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ordres_fabrication_generation_level_ck'
      AND conrelid = 'public.ordres_fabrication'::regclass
  ) THEN
    ALTER TABLE public.ordres_fabrication
      ADD CONSTRAINT ordres_fabrication_generation_level_ck
      CHECK (generation_level >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ordres_fabrication_generation_quantities_ck'
      AND conrelid = 'public.ordres_fabrication'::regclass
  ) THEN
    ALTER TABLE public.ordres_fabrication
      ADD CONSTRAINT ordres_fabrication_generation_quantities_ck
      CHECK (quantity_per_parent > 0 AND quantity_cumulative > 0);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS ordres_fabrication_parent_of_idx
  ON public.ordres_fabrication(parent_of_id)
  WHERE parent_of_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ordres_fabrication_root_of_idx
  ON public.ordres_fabrication(root_of_id)
  WHERE root_of_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ordres_fabrication_generation_batch_idx
  ON public.ordres_fabrication(generation_batch_id)
  WHERE generation_batch_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ordres_fabrication_source_bom_line_idx
  ON public.ordres_fabrication(source_bom_line_id)
  WHERE source_bom_line_id IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'of_generation_batches_commande_id_fkey'
      AND conrelid = 'public.of_generation_batches'::regclass
  ) THEN
    ALTER TABLE public.of_generation_batches
      ADD CONSTRAINT of_generation_batches_commande_id_fkey
      FOREIGN KEY (commande_id) REFERENCES public.commande_client(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'of_generation_batches_commande_ligne_id_fkey'
      AND conrelid = 'public.of_generation_batches'::regclass
  ) THEN
    ALTER TABLE public.of_generation_batches
      ADD CONSTRAINT of_generation_batches_commande_ligne_id_fkey
      FOREIGN KEY (commande_ligne_id) REFERENCES public.commande_ligne(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'of_generation_batches_root_of_id_fkey'
      AND conrelid = 'public.of_generation_batches'::regclass
  ) THEN
    ALTER TABLE public.of_generation_batches
      ADD CONSTRAINT of_generation_batches_root_of_id_fkey
      FOREIGN KEY (root_of_id) REFERENCES public.ordres_fabrication(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'of_generation_batches_root_piece_technique_id_fkey'
      AND conrelid = 'public.of_generation_batches'::regclass
  ) THEN
    ALTER TABLE public.of_generation_batches
      ADD CONSTRAINT of_generation_batches_root_piece_technique_id_fkey
      FOREIGN KEY (root_piece_technique_id) REFERENCES public.pieces_techniques(id) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS of_generation_batches_commande_idx
  ON public.of_generation_batches(commande_id, commande_ligne_id)
  WHERE commande_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.of_structure_snapshot
(
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  generation_batch_id uuid NULL,
  root_of_id bigint NOT NULL,
  parent_of_id bigint NULL,
  of_id bigint NOT NULL,
  level integer NOT NULL,
  structure_path text NOT NULL,
  source_bom_line_id uuid NULL,
  parent_piece_technique_id uuid NULL,
  piece_technique_id uuid NOT NULL,
  piece_code text NOT NULL,
  piece_designation text NOT NULL,
  piece_version_number integer NOT NULL DEFAULT 1,
  quantite_par_parent numeric(12, 3) NOT NULL DEFAULT 1,
  quantite_cumulee numeric(12, 3) NOT NULL DEFAULT 1,
  quantite_lancee numeric(12, 3) NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT of_structure_snapshot_pkey PRIMARY KEY (id),
  CONSTRAINT of_structure_snapshot_of_id_key UNIQUE (of_id),
  CONSTRAINT of_structure_snapshot_level_ck CHECK (level >= 0),
  CONSTRAINT of_structure_snapshot_quantities_ck CHECK (
    quantite_par_parent > 0
    AND quantite_cumulee > 0
    AND quantite_lancee > 0
  )
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'of_structure_snapshot_generation_batch_id_fkey'
      AND conrelid = 'public.of_structure_snapshot'::regclass
  ) THEN
    ALTER TABLE public.of_structure_snapshot
      ADD CONSTRAINT of_structure_snapshot_generation_batch_id_fkey
      FOREIGN KEY (generation_batch_id) REFERENCES public.of_generation_batches(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'of_structure_snapshot_root_of_id_fkey'
      AND conrelid = 'public.of_structure_snapshot'::regclass
  ) THEN
    ALTER TABLE public.of_structure_snapshot
      ADD CONSTRAINT of_structure_snapshot_root_of_id_fkey
      FOREIGN KEY (root_of_id) REFERENCES public.ordres_fabrication(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'of_structure_snapshot_parent_of_id_fkey'
      AND conrelid = 'public.of_structure_snapshot'::regclass
  ) THEN
    ALTER TABLE public.of_structure_snapshot
      ADD CONSTRAINT of_structure_snapshot_parent_of_id_fkey
      FOREIGN KEY (parent_of_id) REFERENCES public.ordres_fabrication(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'of_structure_snapshot_of_id_fkey'
      AND conrelid = 'public.of_structure_snapshot'::regclass
  ) THEN
    ALTER TABLE public.of_structure_snapshot
      ADD CONSTRAINT of_structure_snapshot_of_id_fkey
      FOREIGN KEY (of_id) REFERENCES public.ordres_fabrication(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'of_structure_snapshot_source_bom_line_id_fkey'
      AND conrelid = 'public.of_structure_snapshot'::regclass
  ) THEN
    ALTER TABLE public.of_structure_snapshot
      ADD CONSTRAINT of_structure_snapshot_source_bom_line_id_fkey
      FOREIGN KEY (source_bom_line_id) REFERENCES public.pieces_techniques_nomenclature(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'of_structure_snapshot_piece_technique_id_fkey'
      AND conrelid = 'public.of_structure_snapshot'::regclass
  ) THEN
    ALTER TABLE public.of_structure_snapshot
      ADD CONSTRAINT of_structure_snapshot_piece_technique_id_fkey
      FOREIGN KEY (piece_technique_id) REFERENCES public.pieces_techniques(id) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS of_structure_snapshot_root_of_idx
  ON public.of_structure_snapshot(root_of_id, level, structure_path);

CREATE INDEX IF NOT EXISTS of_structure_snapshot_generation_batch_idx
  ON public.of_structure_snapshot(generation_batch_id)
  WHERE generation_batch_id IS NOT NULL;

ALTER TABLE public.of_operations
  ADD COLUMN IF NOT EXISTS source_piece_operation_id uuid NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'of_operations_source_piece_operation_id_fkey'
      AND conrelid = 'public.of_operations'::regclass
  ) THEN
    ALTER TABLE public.of_operations
      ADD CONSTRAINT of_operations_source_piece_operation_id_fkey
      FOREIGN KEY (source_piece_operation_id) REFERENCES public.pieces_techniques_operations(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS of_operations_source_piece_operation_idx
  ON public.of_operations(source_piece_operation_id)
  WHERE source_piece_operation_id IS NOT NULL;
