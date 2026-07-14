-- Guarded rollback for 20260713_codification_versions_of_vsm.sql.
-- It is intentionally refused when post-patch records or metadata would be lost.
-- Do not run on production without an approved restore rehearsal.

BEGIN;

DO $$
BEGIN
  IF current_setting('cerp.confirm_codification_rollback', true) IS DISTINCT FROM 'APPROVED' THEN
    RAISE EXCEPTION 'Set cerp.confirm_codification_rollback=APPROVED only after human validation';
  END IF;
  IF to_regclass('public.codification_141_piece_version_baseline') IS NULL
     OR to_regclass('public.codification_141_quality_control_baseline') IS NULL
     OR to_regclass('public.codification_141_sequence_baseline') IS NULL THEN
    RAISE EXCEPTION 'Rollback refused: the migration baseline is unavailable';
  END IF;
  IF EXISTS (SELECT 1 FROM public.of_technical_snapshots)
     OR EXISTS (SELECT 1 FROM public.project_evidence_files) THEN
    RAISE EXCEPTION 'Rollback refused: snapshots or evidence exist and must be retained or restored deliberately';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.piece_technique_versions v
    LEFT JOIN public.codification_141_piece_version_baseline b ON b.version_id = v.id
    WHERE b.version_id IS NULL
       OR v.version_interne IS DISTINCT FROM b.version_interne
       OR v.indice_externe_original IS DISTINCT FROM b.indice_externe_original
       OR v.indice_externe_normalise IS DISTINCT FROM b.indice_externe_normalise
       OR v.code_metier IS DISTINCT FROM b.code_metier
       OR v.code_metier_normalise IS DISTINCT FROM b.code_metier_normalise
       OR v.motif_modification IS DISTINCT FROM b.motif_modification
       OR v.date_effet IS DISTINCT FROM b.date_effet
  ) THEN
    RAISE EXCEPTION 'Rollback refused: post-migration technical-version metadata or versions would be lost';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.quality_control q
    LEFT JOIN public.codification_141_quality_control_baseline b ON b.control_id = q.id
    WHERE b.control_id IS NULL OR q.reference IS DISTINCT FROM b.reference
  ) THEN
    RAISE EXCEPTION 'Rollback refused: post-migration quality-control references would be lost';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.codification_141_sequence_baseline b
    CROSS JOIN public.cerp_business_code_issue_seq s
    WHERE b.sequence_name = 'public.cerp_business_code_issue_seq'
      AND (s.last_value IS DISTINCT FROM b.last_value OR s.is_called IS DISTINCT FROM b.is_called)
  ) THEN
    RAISE EXCEPTION 'Rollback refused: a non-reusable business-code number was allocated after migration';
  END IF;
END;
$$;

DROP TABLE IF EXISTS public.project_evidence_files;
DROP TRIGGER IF EXISTS trg_prevent_of_snapshot_record_mutation ON public.of_technical_snapshots;
DROP TABLE IF EXISTS public.of_technical_snapshots;

DROP TRIGGER IF EXISTS trg_assert_of_technical_snapshot_coherence ON public.ordres_fabrication;
DROP TRIGGER IF EXISTS trg_prevent_of_technical_snapshot_mutation ON public.ordres_fabrication;
DROP FUNCTION IF EXISTS public.fn_assert_of_technical_snapshot_coherence();
DROP FUNCTION IF EXISTS public.fn_prevent_of_technical_snapshot_mutation();
DROP FUNCTION IF EXISTS public.fn_prevent_of_snapshot_record_mutation();
DROP INDEX IF EXISTS public.ordres_fabrication_piece_version_idx;
ALTER TABLE public.ordres_fabrication
  DROP CONSTRAINT IF EXISTS ordres_fabrication_technical_snapshot_sha256_check,
  DROP COLUMN IF EXISTS technical_snapshot_at,
  DROP COLUMN IF EXISTS technical_snapshot_sha256,
  DROP COLUMN IF EXISTS technical_snapshot,
  DROP COLUMN IF EXISTS piece_technique_version_id;

DROP TRIGGER IF EXISTS trg_prevent_validated_piece_version_mutation ON public.piece_technique_versions;
DROP TRIGGER IF EXISTS trg_assign_piece_technique_internal_version ON public.piece_technique_versions;
DROP TRIGGER IF EXISTS trg_normalize_piece_technique_version_code ON public.piece_technique_versions;
DROP FUNCTION IF EXISTS public.fn_prevent_validated_piece_version_mutation();
DROP FUNCTION IF EXISTS public.fn_assign_piece_technique_internal_version();
DROP FUNCTION IF EXISTS public.fn_normalize_piece_technique_version_code();
DROP INDEX IF EXISTS public.piece_technique_versions_internal_version_uq;
DROP INDEX IF EXISTS public.piece_technique_versions_code_search_idx;
ALTER TABLE public.piece_technique_versions
  DROP CONSTRAINT IF EXISTS piece_technique_versions_version_interne_positive,
  DROP COLUMN IF EXISTS date_effet,
  DROP COLUMN IF EXISTS motif_modification,
  DROP COLUMN IF EXISTS code_metier_normalise,
  DROP COLUMN IF EXISTS code_metier,
  DROP COLUMN IF EXISTS version_interne,
  DROP COLUMN IF EXISTS indice_externe_normalise,
  DROP COLUMN IF EXISTS indice_externe_original;

ALTER TABLE public.piece_technique_versions
  ADD CONSTRAINT piece_technique_versions_piece_indice_uq UNIQUE (piece_technique_id, indice);

DROP TRIGGER IF EXISTS trg_prevent_quality_control_reference_mutation ON public.quality_control;
DROP FUNCTION IF EXISTS public.fn_prevent_quality_control_reference_mutation();
DROP INDEX IF EXISTS public.quality_control_reference_uq;
ALTER TABLE public.quality_control DROP COLUMN IF EXISTS reference;

DROP TABLE IF EXISTS public.codification_141_piece_version_baseline;
DROP TABLE IF EXISTS public.codification_141_quality_control_baseline;
DROP TABLE IF EXISTS public.codification_141_sequence_baseline;

DROP FUNCTION IF EXISTS public.fn_next_issued_code_value(text);
DROP SEQUENCE IF EXISTS public.cerp_business_code_issue_seq;

-- PostgreSQL enum values cannot be safely removed in a transactional rollback.
-- `po_evidence_type.VSM` is additive and intentionally remains after a safe
-- structural rollback.

COMMIT;
