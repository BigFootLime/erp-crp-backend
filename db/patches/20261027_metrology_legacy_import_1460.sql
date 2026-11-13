-- #1460 Legacy metrology replacement.  Additive only: imported facts never
-- masquerade as validated CERP executions and existing ERP records are never
-- updated by this patch.
BEGIN;

CREATE TABLE IF NOT EXISTS public.metrologie_import_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_set_sha256 text NOT NULL UNIQUE,
  parser_version text NOT NULL,
  status text NOT NULL DEFAULT 'STAGED',
  manifest jsonb NOT NULL DEFAULT '{}'::jsonb,
  reconciliation jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by integer NULL REFERENCES public.users(id) ON DELETE SET NULL,
  applied_at timestamptz NULL,
  applied_by integer NULL REFERENCES public.users(id) ON DELETE SET NULL,
  CONSTRAINT metrologie_import_batches_sha_ck CHECK (source_set_sha256 ~ '^[A-Fa-f0-9]{64}$'),
  CONSTRAINT metrologie_import_batches_status_ck CHECK (status IN ('STAGED','REVIEW_REQUIRED','APPROVED','APPLIED','RECONCILED','FAILED')),
  CONSTRAINT metrologie_import_batches_manifest_object_ck CHECK (jsonb_typeof(manifest) = 'object'),
  CONSTRAINT metrologie_import_batches_reconciliation_object_ck CHECK (jsonb_typeof(reconciliation) = 'object')
);

CREATE TABLE IF NOT EXISTS public.metrologie_import_source_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES public.metrologie_import_batches(id) ON DELETE RESTRICT,
  source_name text NOT NULL,
  sha256 text NOT NULL,
  mime_type text NULL,
  storage_path text NOT NULL,
  size_bytes bigint NOT NULL,
  av_status text NOT NULL DEFAULT 'PENDING',
  av_scanned_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT metrologie_import_source_files_uq UNIQUE (batch_id, source_name),
  CONSTRAINT metrologie_import_source_files_sha_ck CHECK (sha256 ~ '^[A-Fa-f0-9]{64}$'),
  CONSTRAINT metrologie_import_source_files_av_ck CHECK (av_status IN ('PENDING','CLEAN','REJECTED','ERROR')),
  CONSTRAINT metrologie_import_source_files_name_ck CHECK (btrim(source_name) <> ''),
  CONSTRAINT metrologie_import_source_files_path_ck CHECK (btrim(storage_path) <> ''),
  CONSTRAINT metrologie_import_source_files_size_ck CHECK (size_bytes >= 0)
);

CREATE TABLE IF NOT EXISTS public.metrologie_import_raw_rows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_file_id uuid NOT NULL REFERENCES public.metrologie_import_source_files(id) ON DELETE RESTRICT,
  sheet_name text NOT NULL,
  source_coordinate text NOT NULL,
  row_sha256 text NOT NULL,
  source_equipment_key text NULL,
  raw_cells jsonb NOT NULL,
  normalized jsonb NOT NULL DEFAULT '{}'::jsonb,
  disposition text NOT NULL DEFAULT 'PENDING',
  diagnostic jsonb NOT NULL DEFAULT '[]'::jsonb,
  target_equipment_id uuid NULL REFERENCES public.metrologie_equipements(id) ON DELETE RESTRICT,
  resolved_by integer NULL REFERENCES public.users(id) ON DELETE SET NULL,
  resolved_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT metrologie_import_raw_rows_uq UNIQUE (source_file_id, sheet_name, source_coordinate, row_sha256),
  CONSTRAINT metrologie_import_raw_rows_sha_ck CHECK (row_sha256 ~ '^[A-Fa-f0-9]{64}$'),
  CONSTRAINT metrologie_import_raw_rows_disposition_ck CHECK (disposition IN ('PENDING','IMPORTED','AMBIGUOUS','SKIPPED','CONFLICT')),
  CONSTRAINT metrologie_import_raw_rows_cells_object_ck CHECK (jsonb_typeof(raw_cells) = 'object'),
  CONSTRAINT metrologie_import_raw_rows_normalized_object_ck CHECK (jsonb_typeof(normalized) = 'object'),
  CONSTRAINT metrologie_import_raw_rows_diagnostic_array_ck CHECK (jsonb_typeof(diagnostic) = 'array')
);

CREATE TABLE IF NOT EXISTS public.metrologie_legacy_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  raw_row_id uuid NOT NULL UNIQUE REFERENCES public.metrologie_import_raw_rows(id) ON DELETE RESTRICT,
  equipement_id uuid NOT NULL REFERENCES public.metrologie_equipements(id) ON DELETE RESTRICT,
  observed_on date NULL,
  observed_date_raw text NULL,
  legacy_visa_text text NULL,
  legacy_verdict_text text NULL,
  raw_values jsonb NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  imported_by integer NULL REFERENCES public.users(id) ON DELETE SET NULL,
  CONSTRAINT metrologie_legacy_observations_raw_ck CHECK (jsonb_typeof(raw_values) = 'object')
);
CREATE INDEX IF NOT EXISTS metrologie_legacy_observations_equipment_idx ON public.metrologie_legacy_observations (equipement_id, observed_on DESC);
CREATE INDEX IF NOT EXISTS metrologie_import_raw_rows_batch_idx ON public.metrologie_import_raw_rows (source_file_id, disposition);

CREATE OR REPLACE FUNCTION public.fn_protect_metrologie_legacy_import_1460()
RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'metrology legacy import evidence is immutable'; END $$;
CREATE OR REPLACE FUNCTION public.fn_protect_metrologie_import_batch_1460()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'metrology legacy import batches are append-only';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.source_set_sha256 IS DISTINCT FROM OLD.source_set_sha256
     OR NEW.parser_version IS DISTINCT FROM OLD.parser_version
     OR NEW.manifest IS DISTINCT FROM OLD.manifest
     OR NEW.reconciliation IS DISTINCT FROM OLD.reconciliation
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'metrology legacy import batch evidence is immutable';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_protect_metrologie_import_batch_1460 ON public.metrologie_import_batches;
CREATE TRIGGER trg_protect_metrologie_import_batch_1460
  BEFORE UPDATE OR DELETE ON public.metrologie_import_batches
  FOR EACH ROW EXECUTE FUNCTION public.fn_protect_metrologie_import_batch_1460();
DROP TRIGGER IF EXISTS trg_protect_metrologie_import_source_files_1460 ON public.metrologie_import_source_files;
CREATE TRIGGER trg_protect_metrologie_import_source_files_1460 BEFORE UPDATE OR DELETE ON public.metrologie_import_source_files FOR EACH ROW EXECUTE FUNCTION public.fn_protect_metrologie_legacy_import_1460();
DROP TRIGGER IF EXISTS trg_protect_metrologie_import_raw_rows_1460 ON public.metrologie_import_raw_rows;
CREATE TRIGGER trg_protect_metrologie_import_raw_rows_1460 BEFORE DELETE ON public.metrologie_import_raw_rows FOR EACH ROW EXECUTE FUNCTION public.fn_protect_metrologie_legacy_import_1460();
-- Resolution fields are workflow metadata.  The captured cells, normalized
-- facts and coordinates are evidence and can never be revised after staging.
CREATE OR REPLACE FUNCTION public.fn_protect_metrologie_import_raw_facts_1460()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source_file_id IS DISTINCT FROM OLD.source_file_id
     OR NEW.sheet_name IS DISTINCT FROM OLD.sheet_name
     OR NEW.source_coordinate IS DISTINCT FROM OLD.source_coordinate
     OR NEW.row_sha256 IS DISTINCT FROM OLD.row_sha256
     OR NEW.source_equipment_key IS DISTINCT FROM OLD.source_equipment_key
     OR NEW.raw_cells IS DISTINCT FROM OLD.raw_cells
     OR NEW.normalized IS DISTINCT FROM OLD.normalized
     OR NEW.diagnostic IS DISTINCT FROM OLD.diagnostic THEN
    RAISE EXCEPTION 'metrology legacy import raw facts are immutable';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_protect_metrologie_import_raw_facts_1460 ON public.metrologie_import_raw_rows;
CREATE TRIGGER trg_protect_metrologie_import_raw_facts_1460 BEFORE UPDATE ON public.metrologie_import_raw_rows FOR EACH ROW EXECUTE FUNCTION public.fn_protect_metrologie_import_raw_facts_1460();
CREATE INDEX IF NOT EXISTS metrologie_import_raw_rows_group_1460_idx
  ON public.metrologie_import_raw_rows ((normalized->>'group_id'));
DROP TRIGGER IF EXISTS trg_protect_metrologie_legacy_observations_1460 ON public.metrologie_legacy_observations;
CREATE TRIGGER trg_protect_metrologie_legacy_observations_1460 BEFORE UPDATE OR DELETE ON public.metrologie_legacy_observations FOR EACH ROW EXECUTE FUNCTION public.fn_protect_metrologie_legacy_import_1460();

DO $runtime$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app') THEN
    RAISE EXCEPTION 'missing PostgreSQL role cerp_app';
  END IF;
  ALTER TABLE public.metrologie_import_batches OWNER TO cerp_app;
  ALTER TABLE public.metrologie_import_source_files OWNER TO cerp_app;
  ALTER TABLE public.metrologie_import_raw_rows OWNER TO cerp_app;
  ALTER TABLE public.metrologie_legacy_observations OWNER TO cerp_app;
  GRANT SELECT, INSERT, UPDATE ON public.metrologie_import_batches,
    public.metrologie_import_source_files, public.metrologie_import_raw_rows,
    public.metrologie_legacy_observations TO cerp_app;
  ALTER FUNCTION public.fn_protect_metrologie_legacy_import_1460() OWNER TO cerp_app;
  ALTER FUNCTION public.fn_protect_metrologie_import_batch_1460() OWNER TO cerp_app;
  ALTER FUNCTION public.fn_protect_metrologie_import_raw_facts_1460() OWNER TO cerp_app;
END
$runtime$;
COMMIT;
