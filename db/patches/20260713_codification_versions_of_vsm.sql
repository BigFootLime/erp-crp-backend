-- 20260713_codification_versions_of_vsm.sql
--
-- Additive codification, technical-version, OF snapshot and VSM-evidence foundation.
-- Apply on cerp_test first. Never run on cerp_prod without an approved backup,
-- preview report and rollback rehearsal.

BEGIN;

-- `nextval` advances outside the caller transaction.  It is therefore the
-- allocation primitive for business references: a failed request leaves a
-- gap, never a number that can be issued again.  The argument remains a
-- strict whitelist so application callers cannot turn this into an arbitrary
-- sequence allocator.
CREATE SEQUENCE IF NOT EXISTS public.cerp_business_code_issue_seq
  AS bigint MINVALUE 1 START WITH 1 INCREMENT BY 1;

DO $$
DECLARE
  v_legacy_next bigint := 0;
  v_current bigint := 1;
BEGIN
  IF to_regclass('public.code_sequences') IS NOT NULL THEN
    SELECT COALESCE(MAX(next_value), 0) INTO v_legacy_next FROM public.code_sequences;
  END IF;
  SELECT last_value INTO v_current FROM public.cerp_business_code_issue_seq;
  IF v_legacy_next > v_current THEN
    PERFORM setval('public.cerp_business_code_issue_seq', v_legacy_next, true);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_next_issued_code_value(p_scope text)
RETURNS bigint
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
  v_scope text := upper(btrim(COALESCE(p_scope, '')));
BEGIN
  IF v_scope !~ '^(CLI|FOU|ART:[A-Z0-9]{1,48}|(DEV|CMD|AFF|OF|LOT|MVT|CQ|NC|CAPA|BL|FACT):[0-9]{4})$' THEN
    RAISE EXCEPTION 'Unsupported business-code sequence scope: %', p_scope
      USING ERRCODE = '22023';
  END IF;
  RETURN nextval('public.cerp_business_code_issue_seq'::regclass);
END;
$$;

COMMENT ON FUNCTION public.fn_next_issued_code_value(text) IS
  'Whitelisted, non-reusable business-code allocator backed by a native PostgreSQL sequence.';

-- Technical piece revisions: external plan index stays distinct from the internal revision.
ALTER TABLE public.piece_technique_versions
  ADD COLUMN IF NOT EXISTS indice_externe_original text,
  ADD COLUMN IF NOT EXISTS indice_externe_normalise text,
  ADD COLUMN IF NOT EXISTS version_interne integer,
  ADD COLUMN IF NOT EXISTS code_metier text,
  ADD COLUMN IF NOT EXISTS code_metier_normalise text,
  ADD COLUMN IF NOT EXISTS motif_modification text,
  ADD COLUMN IF NOT EXISTS date_effet date;

WITH numbered AS (
  SELECT id, row_number() OVER (PARTITION BY piece_technique_id ORDER BY created_at, id)::integer AS n
  FROM public.piece_technique_versions
)
UPDATE public.piece_technique_versions v
SET version_interne = numbered.n
FROM numbered
WHERE v.id = numbered.id AND v.version_interne IS NULL;

UPDATE public.piece_technique_versions
SET indice_externe_original = COALESCE(indice_externe_original, indice),
    indice_externe_normalise = COALESCE(indice_externe_normalise, upper(regexp_replace(COALESCE(indice_externe_original, indice), '[^A-Za-z0-9]+', '', 'g'))),
    motif_modification = COALESCE(motif_modification, raison_changement, commentaire_revision),
    date_effet = COALESCE(date_effet, date_application)
WHERE indice_externe_original IS NULL
   OR indice_externe_normalise IS NULL
   OR motif_modification IS NULL
   OR date_effet IS NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.piece_technique_versions v
    JOIN public.pieces_techniques pt ON pt.id = v.piece_technique_id
    LEFT JOIN public.clients c ON c.client_id = pt.client_id
    WHERE btrim(COALESCE(c.client_code, pt.code_client, '')) = ''
       OR btrim(COALESCE(v.plan_reference, '')) = ''
       OR btrim(COALESCE(v.indice_externe_original, v.indice, '')) = ''
  ) THEN
    RAISE EXCEPTION
      'Cannot derive piece-version business codes without client, plan and external index; run 20260713 preflight and resolve mappings explicitly';
  END IF;
END;
$$;

WITH code_source AS (
  SELECT
    v.id,
    CASE
      WHEN regexp_replace(upper(regexp_replace(COALESCE(c.client_code, pt.code_client), '[^A-Za-z0-9]+', '', 'g')), '^CLI', '') ~ '^[0-9]+$'
        THEN lpad(regexp_replace(upper(regexp_replace(COALESCE(c.client_code, pt.code_client), '[^A-Za-z0-9]+', '', 'g')), '^CLI', ''), 3, '0')
      ELSE regexp_replace(upper(regexp_replace(COALESCE(c.client_code, pt.code_client), '[^A-Za-z0-9]+', '', 'g')), '^CLI', '')
    END AS client_segment,
    upper(regexp_replace(v.plan_reference, '[^A-Za-z0-9]+', '', 'g')) AS plan_segment,
    upper(regexp_replace(COALESCE(v.indice_externe_original, v.indice), '[^A-Za-z0-9]+', '', 'g')) AS indice_segment
  FROM public.piece_technique_versions v
  JOIN public.pieces_techniques pt ON pt.id = v.piece_technique_id
  LEFT JOIN public.clients c ON c.client_id = pt.client_id
)
UPDATE public.piece_technique_versions v
SET code_metier = concat_ws('-', s.client_segment, s.plan_segment, s.indice_segment),
    code_metier_normalise = concat_ws('', s.client_segment, s.plan_segment, s.indice_segment)
FROM code_source s
WHERE s.id = v.id;

-- The historical `(piece_technique_id, indice)` key prevents a customer index
-- from being reused across internal revisions.  Internal version is now the
-- actual uniqueness boundary; keep the external index as traceable metadata.
ALTER TABLE public.piece_technique_versions
  DROP CONSTRAINT IF EXISTS piece_technique_versions_piece_indice_uq;
DROP INDEX IF EXISTS public.piece_technique_versions_piece_indice_uq;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.piece_technique_versions
    WHERE version_interne IS NOT NULL
    GROUP BY piece_technique_id, version_interne
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot create internal-version uniqueness: duplicate (piece_technique_id, version_interne) values detected';
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'piece_technique_versions_version_interne_positive'
      AND conrelid = 'public.piece_technique_versions'::regclass
  ) THEN
    ALTER TABLE public.piece_technique_versions
      ADD CONSTRAINT piece_technique_versions_version_interne_positive
      CHECK (version_interne IS NULL OR version_interne > 0);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS piece_technique_versions_internal_version_uq
  ON public.piece_technique_versions (piece_technique_id, version_interne)
  WHERE version_interne IS NOT NULL;
CREATE INDEX IF NOT EXISTS piece_technique_versions_code_search_idx
  ON public.piece_technique_versions (code_metier_normalise)
  WHERE code_metier_normalise IS NOT NULL;

CREATE OR REPLACE FUNCTION public.fn_normalize_piece_technique_version_code()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.indice_externe_normalise := CASE
    WHEN NEW.indice_externe_original IS NULL THEN NULL
    ELSE upper(regexp_replace(NEW.indice_externe_original, '[^A-Za-z0-9]+', '', 'g'))
  END;
  NEW.code_metier_normalise := CASE
    WHEN NEW.code_metier IS NULL THEN NULL
    ELSE upper(regexp_replace(NEW.code_metier, '[^A-Za-z0-9]+', '', 'g'))
  END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_normalize_piece_technique_version_code ON public.piece_technique_versions;
CREATE TRIGGER trg_normalize_piece_technique_version_code
  BEFORE INSERT OR UPDATE OF indice_externe_original, code_metier
  ON public.piece_technique_versions
  FOR EACH ROW EXECUTE FUNCTION public.fn_normalize_piece_technique_version_code();

-- Internal revision numbers are allocated under a transaction-scoped advisory
-- lock so concurrent edits of the same technical part cannot receive a
-- duplicate number.  The application never calculates this value itself.
CREATE OR REPLACE FUNCTION public.fn_assign_piece_technique_internal_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.version_interne IS NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(NEW.piece_technique_id::text, 0));
    SELECT COALESCE(MAX(version_interne), 0) + 1
      INTO NEW.version_interne
      FROM public.piece_technique_versions
     WHERE piece_technique_id = NEW.piece_technique_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_assign_piece_technique_internal_version ON public.piece_technique_versions;
CREATE TRIGGER trg_assign_piece_technique_internal_version
  BEFORE INSERT ON public.piece_technique_versions
  FOR EACH ROW EXECUTE FUNCTION public.fn_assign_piece_technique_internal_version();

CREATE OR REPLACE FUNCTION public.fn_prevent_validated_piece_version_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.statut IN ('APPLICABLE', 'OBSOLETE') THEN
    RAISE EXCEPTION 'Validated technical versions are retained for traceability'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.statut IN ('APPLICABLE', 'OBSOLETE') THEN
    IF OLD.statut = 'APPLICABLE'
       AND NEW.statut = 'OBSOLETE'
       AND (to_jsonb(NEW) - ARRAY['statut', 'is_current', 'updated_at', 'updated_by'])
           IS NOT DISTINCT FROM (to_jsonb(OLD) - ARRAY['statut', 'is_current', 'updated_at', 'updated_by']) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Validated technical versions are immutable; create a new version instead'
      USING ERRCODE = '55000';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_validated_piece_version_mutation ON public.piece_technique_versions;
CREATE TRIGGER trg_prevent_validated_piece_version_mutation
  BEFORE UPDATE OR DELETE ON public.piece_technique_versions
  FOR EACH ROW EXECUTE FUNCTION public.fn_prevent_validated_piece_version_mutation();

-- The direct OF flow receives the selected version and stores an immutable technical snapshot.
ALTER TABLE public.ordres_fabrication
  ADD COLUMN IF NOT EXISTS piece_technique_version_id uuid REFERENCES public.piece_technique_versions(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS technical_snapshot jsonb,
  ADD COLUMN IF NOT EXISTS technical_snapshot_sha256 text,
  ADD COLUMN IF NOT EXISTS technical_snapshot_at timestamptz;
CREATE INDEX IF NOT EXISTS ordres_fabrication_piece_version_idx
  ON public.ordres_fabrication (piece_technique_version_id)
  WHERE piece_technique_version_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.of_technical_snapshots (
  of_id bigint PRIMARY KEY REFERENCES public.ordres_fabrication(id) ON DELETE RESTRICT,
  piece_technique_version_id uuid NOT NULL REFERENCES public.piece_technique_versions(id) ON DELETE RESTRICT,
  snapshot jsonb NOT NULL,
  snapshot_sha256 text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by integer NULL REFERENCES public.users(id) ON DELETE SET NULL,
  CONSTRAINT of_technical_snapshots_sha256_check CHECK (snapshot_sha256 ~ '^[A-Fa-f0-9]{64}$')
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ordres_fabrication_technical_snapshot_sha256_check'
      AND conrelid = 'public.ordres_fabrication'::regclass
  ) THEN
    ALTER TABLE public.ordres_fabrication
      ADD CONSTRAINT ordres_fabrication_technical_snapshot_sha256_check
      CHECK (technical_snapshot_sha256 IS NULL OR technical_snapshot_sha256 ~ '^[A-Fa-f0-9]{64}$');
  END IF;
END;
$$;

-- The snapshot companion is immutable, and the deferred coherence trigger
-- permits the application to insert the OF then its snapshot in one atomic
-- transaction while rejecting any incomplete or mismatched pair at COMMIT.
CREATE OR REPLACE FUNCTION public.fn_prevent_of_technical_snapshot_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW.piece_technique_version_id IS DISTINCT FROM OLD.piece_technique_version_id
    OR NEW.technical_snapshot IS DISTINCT FROM OLD.technical_snapshot
    OR NEW.technical_snapshot_sha256 IS DISTINCT FROM OLD.technical_snapshot_sha256
    OR NEW.technical_snapshot_at IS DISTINCT FROM OLD.technical_snapshot_at
  ) THEN
    RAISE EXCEPTION 'OF technical snapshot is immutable after creation'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_of_technical_snapshot_mutation ON public.ordres_fabrication;
CREATE TRIGGER trg_prevent_of_technical_snapshot_mutation
  BEFORE UPDATE OF piece_technique_version_id, technical_snapshot, technical_snapshot_sha256, technical_snapshot_at
  ON public.ordres_fabrication
  FOR EACH ROW EXECUTE FUNCTION public.fn_prevent_of_technical_snapshot_mutation();

CREATE OR REPLACE FUNCTION public.fn_assert_of_technical_snapshot_coherence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_snapshot jsonb;
  v_version_id uuid;
  v_sha256 text;
BEGIN
  -- Existing pre-migration OFs remain updateable until deliberately migrated.
  IF TG_OP = 'UPDATE'
     AND OLD.piece_technique_version_id IS NULL
     AND OLD.technical_snapshot IS NULL
     AND OLD.technical_snapshot_sha256 IS NULL
     AND NEW.piece_technique_version_id IS NULL
     AND NEW.technical_snapshot IS NULL
     AND NEW.technical_snapshot_sha256 IS NULL THEN
    RETURN NULL;
  END IF;

  IF NEW.piece_technique_version_id IS NULL
     OR NEW.technical_snapshot IS NULL
     OR NEW.technical_snapshot_sha256 IS NULL
     OR NEW.technical_snapshot_at IS NULL THEN
    RAISE EXCEPTION 'Every new OF must retain a technical version and immutable snapshot'
      USING ERRCODE = '23514';
  END IF;

  SELECT s.snapshot, s.piece_technique_version_id, s.snapshot_sha256
    INTO v_snapshot, v_version_id, v_sha256
    FROM public.of_technical_snapshots s
   WHERE s.of_id = NEW.id;
  IF NOT FOUND
     OR v_version_id IS DISTINCT FROM NEW.piece_technique_version_id
     OR v_snapshot IS DISTINCT FROM NEW.technical_snapshot
     OR v_sha256 IS DISTINCT FROM NEW.technical_snapshot_sha256 THEN
    RAISE EXCEPTION 'OF technical snapshot companion is missing or inconsistent'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_assert_of_technical_snapshot_coherence ON public.ordres_fabrication;
CREATE CONSTRAINT TRIGGER trg_assert_of_technical_snapshot_coherence
  AFTER INSERT OR UPDATE ON public.ordres_fabrication
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.fn_assert_of_technical_snapshot_coherence();

CREATE OR REPLACE FUNCTION public.fn_prevent_of_snapshot_record_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'OF technical snapshot records are immutable and retained for traceability'
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_of_snapshot_record_mutation ON public.of_technical_snapshots;
CREATE TRIGGER trg_prevent_of_snapshot_record_mutation
  BEFORE UPDATE OR DELETE ON public.of_technical_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.fn_prevent_of_snapshot_record_mutation();

-- Quality controls receive the same canonical CQ reference as the backend.
-- Existing rows are only backfilled after rejecting malformed or ambiguous
-- values; this deliberately avoids a silent remapping in test/production.
ALTER TABLE public.quality_control
  ADD COLUMN IF NOT EXISTS reference text;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.quality_control
    WHERE reference IS NOT NULL
      AND (btrim(reference) = '' OR reference !~ '^CQ-[0-9]{4}-[0-9]{6}$')
  ) THEN
    RAISE EXCEPTION 'quality_control.reference contains non-canonical values; resolve them explicitly before this patch';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.quality_control
    WHERE reference IS NOT NULL
    GROUP BY reference HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'quality_control.reference contains duplicates; resolve them explicitly before this patch';
  END IF;
END;
$$;

WITH existing_max AS (
  SELECT substring(reference FROM '^CQ-[0-9]{4}-([0-9]{6})$')::integer AS sequence_value,
         substring(reference FROM '^CQ-([0-9]{4})-') AS reference_year
    FROM public.quality_control
   WHERE reference IS NOT NULL
), ranked_missing AS (
  SELECT q.id,
         to_char(q.control_date AT TIME ZONE 'UTC', 'YYYY') AS reference_year,
         row_number() OVER (
           PARTITION BY to_char(q.control_date AT TIME ZONE 'UTC', 'YYYY')
           ORDER BY q.control_date, q.id
         )::integer AS row_number
    FROM public.quality_control q
   WHERE q.reference IS NULL
), bases AS (
  SELECT reference_year, COALESCE(max(sequence_value), 0)::integer AS max_sequence
    FROM existing_max GROUP BY reference_year
)
UPDATE public.quality_control q
SET reference = concat('CQ-', r.reference_year, '-', lpad((COALESCE(b.max_sequence, 0) + r.row_number)::text, 6, '0'))
FROM ranked_missing r
LEFT JOIN bases b ON b.reference_year = r.reference_year
WHERE q.id = r.id;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.quality_control
    WHERE reference IS NULL OR reference !~ '^CQ-[0-9]{4}-[0-9]{6}$'
  ) THEN
    RAISE EXCEPTION 'quality_control.reference backfill is incomplete or exceeds canonical CQ format';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.quality_control
    GROUP BY reference HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'quality_control.reference backfill produced a collision';
  END IF;
END;
$$;

ALTER TABLE public.quality_control ALTER COLUMN reference SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS quality_control_reference_uq ON public.quality_control (reference);

-- The deterministic backfill must also reserve its highest suffix in the
-- native allocator, otherwise the first new CQ could collide with a retained
-- historical control in the same year.
DO $$
DECLARE
  v_quality_max bigint := 0;
  v_current bigint := 1;
BEGIN
  SELECT COALESCE(MAX(substring(reference FROM '^CQ-[0-9]{4}-([0-9]{6})$')::bigint), 0)
    INTO v_quality_max
    FROM public.quality_control;
  SELECT last_value INTO v_current FROM public.cerp_business_code_issue_seq;
  IF v_quality_max >= v_current THEN
    PERFORM setval('public.cerp_business_code_issue_seq', v_quality_max, true);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_prevent_quality_control_reference_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.reference IS DISTINCT FROM OLD.reference THEN
    RAISE EXCEPTION 'Quality control reference is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_quality_control_reference_mutation ON public.quality_control;
CREATE TRIGGER trg_prevent_quality_control_reference_mutation
  BEFORE UPDATE OF reference ON public.quality_control
  FOR EACH ROW EXECUTE FUNCTION public.fn_prevent_quality_control_reference_mutation();

-- Project Office keeps evidence metadata in PostgreSQL and the binary in controlled storage.
ALTER TYPE public.po_evidence_type ADD VALUE IF NOT EXISTS 'VSM';

CREATE TABLE IF NOT EXISTS public.project_evidence_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  evidence_id uuid NOT NULL UNIQUE REFERENCES public.project_evidence(id) ON DELETE CASCADE,
  project_id uuid NULL REFERENCES public.project_projects(id) ON DELETE RESTRICT,
  storage_key text NOT NULL UNIQUE,
  original_name text NOT NULL,
  sanitized_name text NOT NULL,
  mime_type text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  sha256 text NOT NULL CHECK (sha256 ~ '^[A-Fa-f0-9]{64}$'),
  category text NOT NULL DEFAULT 'DOCUMENT',
  version_number integer NOT NULL DEFAULT 1 CHECK (version_number > 0),
  status text NOT NULL DEFAULT 'BROUILLON' CHECK (status IN ('BROUILLON', 'VALIDE', 'OBSOLETE')),
  date_effet date NULL,
  visibility text NOT NULL DEFAULT 'INTERNAL' CHECK (visibility IN ('PRIVATE', 'INTERNAL')),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by integer NULL REFERENCES public.users(id) ON DELETE SET NULL,
  CONSTRAINT project_evidence_files_category_check CHECK (category IN ('DOCUMENT', 'VSM'))
);
ALTER TABLE public.project_evidence_files
  ADD COLUMN IF NOT EXISTS project_id uuid NULL REFERENCES public.project_projects(id) ON DELETE RESTRICT;
UPDATE public.project_evidence_files f
SET project_id = e.project_id
FROM public.project_evidence e
WHERE e.id = f.evidence_id AND f.project_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS project_evidence_files_project_sha256_uq
  ON public.project_evidence_files (project_id, sha256)
  WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS project_evidence_files_sha256_idx ON public.project_evidence_files (sha256);

-- A baseline makes rollback conservative but not blindly impossible: it may
-- remove only the schema additions when no post-patch version metadata has
-- changed and no new technical version was created.  The baseline itself is
-- removed only by that proven-safe rollback.
CREATE TABLE IF NOT EXISTS public.codification_141_piece_version_baseline (
  version_id uuid PRIMARY KEY REFERENCES public.piece_technique_versions(id) ON DELETE RESTRICT,
  version_interne integer NULL,
  indice_externe_original text NULL,
  indice_externe_normalise text NULL,
  code_metier text NULL,
  code_metier_normalise text NULL,
  motif_modification text NULL,
  date_effet date NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.codification_141_quality_control_baseline (
  control_id uuid PRIMARY KEY REFERENCES public.quality_control(id) ON DELETE RESTRICT,
  reference text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.codification_141_piece_version_baseline (
  version_id, version_interne, indice_externe_original, indice_externe_normalise,
  code_metier, code_metier_normalise, motif_modification, date_effet
)
SELECT id, version_interne, indice_externe_original, indice_externe_normalise,
       code_metier, code_metier_normalise, motif_modification, date_effet
FROM public.piece_technique_versions
ON CONFLICT (version_id) DO NOTHING;

INSERT INTO public.codification_141_quality_control_baseline (control_id, reference)
SELECT id, reference
FROM public.quality_control
ON CONFLICT (control_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.codification_141_sequence_baseline (
  sequence_name text PRIMARY KEY,
  last_value bigint NOT NULL,
  is_called boolean NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.codification_141_sequence_baseline (sequence_name, last_value, is_called)
SELECT 'public.cerp_business_code_issue_seq', last_value, is_called
FROM public.cerp_business_code_issue_seq
ON CONFLICT (sequence_name) DO NOTHING;

COMMIT;
