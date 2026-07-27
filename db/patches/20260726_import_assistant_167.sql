-- Issue #167 — CLIPPER -> CERP import assistant staging and crosswalk.
-- Additive and idempotent. This patch does not import any business data.

BEGIN;

CREATE TABLE IF NOT EXISTS public.data_import_batches (
  id uuid PRIMARY KEY,
  source_system text NOT NULL,
  entity_type text NOT NULL,
  status text NOT NULL,
  source_name text NOT NULL,
  source_sha256 char(64) NOT NULL,
  source_size bigint NOT NULL CHECK (source_size >= 0),
  source_mime text NULL,
  sheet_name text NOT NULL,
  headers jsonb NOT NULL DEFAULT '[]'::jsonb,
  mapping jsonb NULL,
  preview_hash char(64) NULL,
  summary jsonb NOT NULL DEFAULT '{"total":0,"valid":0,"blocked":0,"duplicates":0,"already_imported":0,"imported":0,"linked":0,"failed":0}'::jsonb,
  last_error text NULL,
  created_by integer NOT NULL REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz NULL,
  retention_until date NOT NULL DEFAULT (CURRENT_DATE + 90),
  CONSTRAINT data_import_batches_entity_ck CHECK (
    entity_type IN ('CLIENT','FOURNISSEUR','ARTICLE','PIECE_TECHNIQUE','MACHINE','STOCK_INITIAL','BL_HISTORIQUE','EMPLOYE')
  ),
  CONSTRAINT data_import_batches_status_ck CHECK (
    status IN ('UPLOADED','SIMULATED','READY','IMPORTING','COMPLETED','COMPLETED_WITH_ERRORS','FAILED')
  ),
  CONSTRAINT data_import_batches_headers_array_ck CHECK (jsonb_typeof(headers) = 'array'),
  CONSTRAINT data_import_batches_summary_object_ck CHECK (jsonb_typeof(summary) = 'object')
);

CREATE UNIQUE INDEX IF NOT EXISTS data_import_batches_source_uq
  ON public.data_import_batches (source_system, entity_type, source_sha256, sheet_name);
CREATE INDEX IF NOT EXISTS data_import_batches_created_idx
  ON public.data_import_batches (created_at DESC);

CREATE TABLE IF NOT EXISTS public.data_import_rows (
  id bigserial PRIMARY KEY,
  batch_id uuid NOT NULL REFERENCES public.data_import_batches(id) ON DELETE RESTRICT,
  row_number integer NOT NULL CHECK (row_number >= 2),
  legacy_key text NULL,
  source_data jsonb NOT NULL,
  normalized_data jsonb NULL,
  status text NOT NULL DEFAULT 'PENDING',
  action text NOT NULL DEFAULT 'CREATE',
  issues jsonb NOT NULL DEFAULT '[]'::jsonb,
  target_id text NULL,
  target_code text NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  processing_started_at timestamptz NULL,
  purged_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT data_import_rows_status_ck CHECK (
    status IN ('PENDING','VALID','BLOCKED','DUPLICATE','ALREADY_IMPORTED','PROCESSING','IMPORTED','LINKED','FAILED')
  ),
  CONSTRAINT data_import_rows_action_ck CHECK (action IN ('CREATE','LINK','SKIP')),
  CONSTRAINT data_import_rows_source_object_ck CHECK (jsonb_typeof(source_data) = 'object'),
  CONSTRAINT data_import_rows_normalized_object_ck CHECK (normalized_data IS NULL OR jsonb_typeof(normalized_data) = 'object'),
  CONSTRAINT data_import_rows_issues_array_ck CHECK (jsonb_typeof(issues) = 'array'),
  CONSTRAINT data_import_rows_batch_row_uq UNIQUE (batch_id, row_number)
);

CREATE INDEX IF NOT EXISTS data_import_rows_batch_status_idx
  ON public.data_import_rows (batch_id, status, row_number);
CREATE INDEX IF NOT EXISTS data_import_rows_legacy_idx
  ON public.data_import_rows (batch_id, legacy_key);

CREATE TABLE IF NOT EXISTS public.data_import_crosswalk (
  id bigserial PRIMARY KEY,
  source_system text NOT NULL,
  entity_type text NOT NULL,
  legacy_key text NOT NULL,
  target_id text NOT NULL,
  target_code text NULL,
  batch_id uuid NOT NULL REFERENCES public.data_import_batches(id) ON DELETE RESTRICT,
  row_id bigint NULL REFERENCES public.data_import_rows(id) ON DELETE SET NULL,
  linked_by integer NOT NULL REFERENCES public.users(id),
  linked_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT data_import_crosswalk_source_uq UNIQUE (source_system, entity_type, legacy_key)
);

CREATE INDEX IF NOT EXISTS data_import_crosswalk_target_idx
  ON public.data_import_crosswalk (entity_type, target_id);

CREATE TABLE IF NOT EXISTS public.data_import_confirm_idempotency (
  actor_user_id integer NOT NULL REFERENCES public.users(id),
  idempotency_key text NOT NULL,
  batch_id uuid NOT NULL REFERENCES public.data_import_batches(id) ON DELETE RESTRICT,
  request_hash char(64) NOT NULL,
  response_status integer NOT NULL,
  response_body jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (actor_user_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS public.fournisseur_create_idempotence (
  idempotency_key text PRIMARY KEY,
  request_hash char(64) NOT NULL,
  fournisseur_id uuid NOT NULL REFERENCES public.fournisseurs(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.piece_technique_create_idempotence (
  idempotency_key text PRIMARY KEY,
  request_hash char(64) NOT NULL,
  piece_technique_id uuid NOT NULL REFERENCES public.pieces_techniques(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.fn_purge_expired_import_staging()
RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE
  affected bigint := 0;
BEGIN
  WITH expired_batches AS (
    SELECT id
    FROM public.data_import_batches
    WHERE retention_until < CURRENT_DATE
      AND status IN ('COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED')
  ),
  purged_rows AS (
    UPDATE public.data_import_rows AS row
    SET source_data = '{}'::jsonb,
        normalized_data = NULL,
        issues = '[]'::jsonb,
        purged_at = now(),
        updated_at = now()
    FROM expired_batches
    WHERE row.batch_id = expired_batches.id
      AND row.purged_at IS NULL
    RETURNING row.id
  )
  SELECT count(*) INTO affected FROM purged_rows;

  UPDATE public.data_import_batches
  SET headers = '[]'::jsonb,
      mapping = NULL,
      updated_at = now()
  WHERE retention_until < CURRENT_DATE
    AND status IN ('COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED')
    AND (headers <> '[]'::jsonb OR mapping IS NOT NULL);

  RETURN affected;
END;
$$;

COMMIT;
