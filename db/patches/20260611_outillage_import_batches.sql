-- Outillage catalogue import tracking.
-- Additive patch only: records batch-level and row-level import evidence.

CREATE TABLE IF NOT EXISTS public.gestion_outils_import_batch (
  id_import_batch bigserial PRIMARY KEY,
  source_filename text,
  source_catalogue text,
  status text NOT NULL DEFAULT 'draft',
  created_tools_count integer NOT NULL DEFAULT 0,
  rejected_rows_count integer NOT NULL DEFAULT 0,
  warning_rows_count integer NOT NULL DEFAULT 0,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  finished_at timestamptz,
  note text,
  CONSTRAINT chk_outillage_import_batch_counts_nonnegative CHECK (
    created_tools_count >= 0
    AND rejected_rows_count >= 0
    AND warning_rows_count >= 0
  ),
  CONSTRAINT chk_outillage_import_batch_status CHECK (
    status IN ('draft', 'running', 'completed', 'completed_with_warnings', 'failed', 'cancelled')
  )
);

CREATE TABLE IF NOT EXISTS public.gestion_outils_import_row (
  id_import_row bigserial PRIMARY KEY,
  id_import_batch bigint NOT NULL REFERENCES public.gestion_outils_import_batch(id_import_batch) ON DELETE CASCADE,
  row_index integer NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  id_outil integer REFERENCES public.gestion_outils_outil(id_outil) ON DELETE SET NULL,
  reference_fabricant text,
  codification text,
  message text,
  raw_payload jsonb,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_outillage_import_row_status CHECK (
    status IN ('pending', 'created', 'updated', 'rejected', 'warning', 'skipped')
  )
);

CREATE INDEX IF NOT EXISTS idx_outillage_import_batch_created_at
  ON public.gestion_outils_import_batch (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_outillage_import_batch_status
  ON public.gestion_outils_import_batch (status);

CREATE INDEX IF NOT EXISTS idx_outillage_import_row_batch_status
  ON public.gestion_outils_import_row (id_import_batch, status);

CREATE INDEX IF NOT EXISTS idx_outillage_import_row_reference
  ON public.gestion_outils_import_row (reference_fabricant)
  WHERE reference_fabricant IS NOT NULL;
