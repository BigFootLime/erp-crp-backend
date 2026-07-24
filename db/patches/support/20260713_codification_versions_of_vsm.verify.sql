-- Read-only verification for 20260713_codification_versions_of_vsm.sql.
-- Run against cerp_test after applying the patch.  It ends with ROLLBACK.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.of_technical_snapshots') IS NULL THEN
    RAISE EXCEPTION 'Missing public.of_technical_snapshots';
  END IF;
  IF to_regclass('public.project_evidence_files') IS NULL THEN
    RAISE EXCEPTION 'Missing public.project_evidence_files';
  END IF;
  IF to_regclass('public.codification_141_piece_version_baseline') IS NULL
     OR to_regclass('public.codification_141_quality_control_baseline') IS NULL
     OR to_regclass('public.codification_141_sequence_baseline') IS NULL THEN
    RAISE EXCEPTION 'Missing codification rollback baselines';
  END IF;
  IF to_regclass('public.cerp_business_code_issue_seq') IS NULL
     OR to_regprocedure('public.fn_next_issued_code_value(text)') IS NULL THEN
    RAISE EXCEPTION 'Missing native non-reusable business-code allocator';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'ordres_fabrication'
      AND column_name IN ('piece_technique_version_id', 'technical_snapshot', 'technical_snapshot_sha256', 'technical_snapshot_at')
    GROUP BY table_schema, table_name HAVING count(*) = 4
  ) THEN
    RAISE EXCEPTION 'OF snapshot columns are incomplete';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_assign_piece_technique_internal_version' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'Missing internal revision allocator trigger';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_prevent_validated_piece_version_mutation' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'Missing validated version immutability trigger';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_assert_of_technical_snapshot_coherence' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'Missing deferred OF snapshot coherence trigger';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_prevent_of_snapshot_record_mutation' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'Missing OF snapshot immutability trigger';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_prevent_quality_control_reference_mutation' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'Missing immutable quality-control reference trigger';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.piece_technique_versions
    WHERE version_interne IS NULL OR code_metier IS NULL
  ) THEN
    RAISE EXCEPTION 'Piece technical version codification backfill is incomplete';
  END IF;
END;
$$;

SELECT indexname
FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname IN (
    'piece_technique_versions_internal_version_uq',
    'piece_technique_versions_code_search_idx',
    'ordres_fabrication_piece_version_idx',
    'project_evidence_files_project_sha256_uq',
    'quality_control_reference_uq'
  )
ORDER BY indexname;

SELECT conname, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid = 'public.project_evidence_files'::regclass
  AND conname = 'project_evidence_files_category_check';

SELECT last_value, is_called FROM public.cerp_business_code_issue_seq;

ROLLBACK;
