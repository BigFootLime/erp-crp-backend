\set ON_ERROR_STOP on

-- Rollback for issue #228, restricted to cerp_test.
--
-- IMPORTANT — irreversible parts:
--   * PostgreSQL cannot remove a value from an enum type. The values added to
--     `quality_nc_status`, `quality_entity_type` and `quality_document_type`
--     stay in place. They are additive and unused by historical rows, so they
--     are harmless; this script refuses to run if any row uses them.
--   * Additive columns are dropped only when they are entirely empty, so a
--     recorded measurement, decision or snapshot is never destroyed here.
DO $$
BEGIN
  IF current_database() <> 'cerp_test' THEN
    RAISE EXCEPTION '#228 rollback is restricted to cerp_test';
  END IF;
END $$;

BEGIN;

-- 0) Refuse to roll back over real quality data.
DO $$
DECLARE
  v_count bigint;
BEGIN
  IF to_regclass('public.quality_release_decision') IS NOT NULL THEN
    SELECT COUNT(*) INTO v_count FROM public.quality_release_decision;
    IF v_count > 0 THEN
      RAISE EXCEPTION '#228 rollback refused: % release decision(s) recorded', v_count;
    END IF;
  END IF;

  IF to_regclass('public.quality_derogation_consumption') IS NOT NULL THEN
    SELECT COUNT(*) INTO v_count FROM public.quality_derogation_consumption;
    IF v_count > 0 THEN
      RAISE EXCEPTION '#228 rollback refused: % derogation consumption(s) recorded', v_count;
    END IF;
  END IF;

  IF to_regclass('public.quality_measurement_revisions') IS NOT NULL THEN
    SELECT COUNT(*) INTO v_count FROM public.quality_measurement_revisions;
    IF v_count > 0 THEN
      RAISE EXCEPTION '#228 rollback refused: % measurement revision(s) recorded', v_count;
    END IF;
  END IF;

  SELECT COUNT(*) INTO v_count
  FROM public.quality_control
  WHERE plan_snapshot_sha256 IS NOT NULL;
  IF v_count > 0 THEN
    RAISE EXCEPTION '#228 rollback refused: % control(s) already carry a plan snapshot', v_count;
  END IF;

  SELECT COUNT(*) INTO v_count
  FROM public.non_conformity
  WHERE status::text IN ('DRAFT', 'DISPOSITION', 'VERIFICATION', 'CANCELLED');
  IF v_count > 0 THEN
    RAISE EXCEPTION '#228 rollback refused: % non-conformity(ies) use an extended status', v_count;
  END IF;
END $$;

-- 1) Guard triggers and functions.
DROP TRIGGER IF EXISTS trg_protect_quality_plan_228 ON public.quality_control_plan;
DROP TRIGGER IF EXISTS trg_protect_quality_plan_char_228 ON public.quality_control_plan_characteristic;
DROP TRIGGER IF EXISTS trg_protect_quality_snapshot_228 ON public.quality_control;
DROP TRIGGER IF EXISTS trg_protect_quality_measurement_228 ON public.quality_control_points;
DROP TRIGGER IF EXISTS trg_quality_event_log_append_only_228 ON public.quality_event_log;
DROP TRIGGER IF EXISTS trg_quality_measurement_revisions_append_only_228 ON public.quality_measurement_revisions;
DROP TRIGGER IF EXISTS trg_quality_release_decision_append_only_228 ON public.quality_release_decision;
DROP TRIGGER IF EXISTS trg_quality_derogation_consumption_append_only_228 ON public.quality_derogation_consumption;
DROP TRIGGER IF EXISTS trg_quality_command_receipts_append_only_228 ON public.quality_command_receipts;
DROP TRIGGER IF EXISTS trg_protect_quality_derogation_228 ON public.quality_derogation;
DROP TRIGGER IF EXISTS trg_check_quality_derogation_cap_228 ON public.quality_derogation_consumption;
DROP TRIGGER IF EXISTS trg_protect_quality_documents_228 ON public.quality_documents;
DROP TRIGGER IF EXISTS quality_control_plan_set_updated_at ON public.quality_control_plan;
DROP TRIGGER IF EXISTS quality_plan_char_set_updated_at ON public.quality_control_plan_characteristic;
DROP TRIGGER IF EXISTS quality_derogation_set_updated_at ON public.quality_derogation;
DROP TRIGGER IF EXISTS non_conformity_analysis_set_updated_at ON public.non_conformity_analysis;

DROP FUNCTION IF EXISTS public.fn_protect_quality_plan_228();
DROP FUNCTION IF EXISTS public.fn_protect_quality_plan_characteristic_228();
DROP FUNCTION IF EXISTS public.fn_protect_quality_snapshot_228();
DROP FUNCTION IF EXISTS public.fn_protect_quality_measurement_228();
DROP FUNCTION IF EXISTS public.fn_quality_append_only_228();
DROP FUNCTION IF EXISTS public.fn_protect_quality_derogation_228();
DROP FUNCTION IF EXISTS public.fn_check_quality_derogation_cap_228();
DROP FUNCTION IF EXISTS public.fn_protect_quality_documents_228();

-- 2) New tables (empty by construction, see step 0).
DROP TABLE IF EXISTS public.quality_derogation_consumption;
DROP TABLE IF EXISTS public.quality_command_receipts;
DROP TABLE IF EXISTS public.quality_measurement_revisions;
DROP TABLE IF EXISTS public.quality_release_decision;
DROP TABLE IF EXISTS public.quality_derogation;
DROP TABLE IF EXISTS public.non_conformity_analysis;
DROP TABLE IF EXISTS public.quality_control_plan_characteristic;
DROP TABLE IF EXISTS public.quality_control_plan;

-- 3) Constraints and indexes added on existing tables.
ALTER TABLE public.quality_control
  DROP CONSTRAINT IF EXISTS quality_control_plan_228_fkey,
  DROP CONSTRAINT IF EXISTS quality_control_verdict_228_ck,
  DROP CONSTRAINT IF EXISTS quality_control_source_type_228_ck,
  DROP CONSTRAINT IF EXISTS quality_control_source_pair_228_ck,
  DROP CONSTRAINT IF EXISTS quality_control_snapshot_pair_228_ck,
  DROP CONSTRAINT IF EXISTS quality_control_snapshot_hash_228_ck,
  DROP CONSTRAINT IF EXISTS quality_control_qty_nonneg_228_ck,
  DROP CONSTRAINT IF EXISTS quality_control_qty_ledger_228_ck;

ALTER TABLE public.quality_control_points
  DROP CONSTRAINT IF EXISTS quality_control_points_sample_228_ck,
  DROP CONSTRAINT IF EXISTS quality_control_points_criticality_228_ck,
  DROP CONSTRAINT IF EXISTS quality_control_points_revision_228_ck,
  DROP CONSTRAINT IF EXISTS quality_control_points_instrument_228_fkey;

ALTER TABLE public.non_conformity
  DROP CONSTRAINT IF EXISTS non_conformity_origin_228_ck,
  DROP CONSTRAINT IF EXISTS non_conformity_confidentiality_228_ck,
  DROP CONSTRAINT IF EXISTS non_conformity_qty_228_ck,
  DROP CONSTRAINT IF EXISTS non_conformity_owner_228_fkey;

ALTER TABLE public.non_conformity_dispositions
  DROP CONSTRAINT IF EXISTS non_conformity_dispositions_derogation_228_fkey,
  DROP CONSTRAINT IF EXISTS non_conformity_dispositions_control_228_fkey;

ALTER TABLE public.quality_action
  DROP CONSTRAINT IF EXISTS quality_action_priority_228_ck,
  DROP CONSTRAINT IF EXISTS quality_action_analysis_228_fkey;

ALTER TABLE public.quality_documents
  DROP CONSTRAINT IF EXISTS quality_documents_confidentiality_228_ck;

DROP INDEX IF EXISTS public.quality_control_plan_228_idx;
DROP INDEX IF EXISTS public.quality_control_source_228_idx;
DROP INDEX IF EXISTS public.quality_control_lot_228_idx;
DROP INDEX IF EXISTS public.quality_control_reception_line_228_idx;
DROP INDEX IF EXISTS public.quality_control_verdict_228_idx;
DROP INDEX IF EXISTS public.quality_control_points_sample_228_uq;
DROP INDEX IF EXISTS public.quality_control_points_instrument_228_idx;
DROP INDEX IF EXISTS public.non_conformity_origin_228_idx;
DROP INDEX IF EXISTS public.non_conformity_owner_228_idx;
DROP INDEX IF EXISTS public.non_conformity_dispositions_idem_228_uq;
DROP INDEX IF EXISTS public.quality_event_log_correlation_228_idx;

-- 4) Restore the historical disposition CHECK list (without RECHECK).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'non_conformity_dispositions_type_check'
      AND conrelid = 'public.non_conformity_dispositions'::regclass
  ) THEN
    ALTER TABLE public.non_conformity_dispositions
      DROP CONSTRAINT non_conformity_dispositions_type_check;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.non_conformity_dispositions WHERE disposition_type = 'RECHECK'
  ) THEN
    ALTER TABLE public.non_conformity_dispositions
      ADD CONSTRAINT non_conformity_dispositions_type_check
      CHECK (disposition_type IN (
        'HOLD', 'RELEASE', 'USE_AS_IS', 'REWORK', 'SORT', 'SCRAP', 'RETURN_SUPPLIER'
      ));
  ELSE
    RAISE NOTICE 'RECHECK dispositions exist; keeping the extended CHECK list.';
  END IF;
END $$;

-- 5) Additive columns, dropped only when empty.
DO $$
DECLARE
  v_used bigint;
BEGIN
  SELECT COUNT(*) INTO v_used
  FROM public.quality_control
  WHERE plan_id IS NOT NULL
     OR plan_snapshot IS NOT NULL
     OR source_type IS NOT NULL
     OR verdict IS NOT NULL
     OR qty_population IS NOT NULL
     OR qty_released <> 0
     OR qty_held <> 0;
  IF v_used > 0 THEN
    RAISE EXCEPTION '#228 rollback refused: % quality control(s) use the new columns', v_used;
  END IF;

  ALTER TABLE public.quality_control
    DROP COLUMN IF EXISTS plan_id,
    DROP COLUMN IF EXISTS plan_version,
    DROP COLUMN IF EXISTS plan_snapshot,
    DROP COLUMN IF EXISTS plan_snapshot_sha256,
    DROP COLUMN IF EXISTS source_type,
    DROP COLUMN IF EXISTS source_id,
    DROP COLUMN IF EXISTS reception_ligne_id,
    DROP COLUMN IF EXISTS reception_inspection_id,
    DROP COLUMN IF EXISTS lot_id,
    DROP COLUMN IF EXISTS article_id,
    DROP COLUMN IF EXISTS fournisseur_id,
    DROP COLUMN IF EXISTS bon_livraison_id,
    DROP COLUMN IF EXISTS trigger_type,
    DROP COLUMN IF EXISTS verdict,
    DROP COLUMN IF EXISTS verdict_computed,
    DROP COLUMN IF EXISTS verdict_override_reason,
    DROP COLUMN IF EXISTS verdict_overridden_by,
    DROP COLUMN IF EXISTS unite,
    DROP COLUMN IF EXISTS qty_population,
    DROP COLUMN IF EXISTS qty_controlled,
    DROP COLUMN IF EXISTS qty_conforming,
    DROP COLUMN IF EXISTS qty_released,
    DROP COLUMN IF EXISTS qty_held,
    DROP COLUMN IF EXISTS qty_scrapped,
    DROP COLUMN IF EXISTS qty_reworked,
    DROP COLUMN IF EXISTS qty_sorted,
    DROP COLUMN IF EXISTS qty_returned,
    DROP COLUMN IF EXISTS qty_consumed,
    DROP COLUMN IF EXISTS correlation_id;

  ALTER TABLE public.quality_control_points
    DROP COLUMN IF EXISTS characteristic_key,
    DROP COLUMN IF EXISTS sample_no,
    DROP COLUMN IF EXISTS value_boolean,
    DROP COLUMN IF EXISTS value_text,
    DROP COLUMN IF EXISTS instrument_id,
    DROP COLUMN IF EXISTS instrument_snapshot,
    DROP COLUMN IF EXISTS evaluation_code,
    DROP COLUMN IF EXISTS criticality,
    DROP COLUMN IF EXISTS measured_at,
    DROP COLUMN IF EXISTS recorded_by,
    DROP COLUMN IF EXISTS revision;

  ALTER TABLE public.non_conformity
    DROP COLUMN IF EXISTS origin,
    DROP COLUMN IF EXISTS defect_category,
    DROP COLUMN IF EXISTS qty,
    DROP COLUMN IF EXISTS unite,
    DROP COLUMN IF EXISTS owner_user_id,
    DROP COLUMN IF EXISTS confidentiality,
    DROP COLUMN IF EXISTS capa_required,
    DROP COLUMN IF EXISTS effectiveness_verified_at,
    DROP COLUMN IF EXISTS effectiveness_verified_by,
    DROP COLUMN IF EXISTS reopened_at,
    DROP COLUMN IF EXISTS reopened_by,
    DROP COLUMN IF EXISTS reopen_reason,
    DROP COLUMN IF EXISTS cancelled_at,
    DROP COLUMN IF EXISTS cancelled_by,
    DROP COLUMN IF EXISTS cancellation_reason,
    DROP COLUMN IF EXISTS correlation_id;

  ALTER TABLE public.non_conformity_dispositions
    DROP COLUMN IF EXISTS derogation_id,
    DROP COLUMN IF EXISTS quality_control_id,
    DROP COLUMN IF EXISTS instructions,
    DROP COLUMN IF EXISTS idempotency_key,
    DROP COLUMN IF EXISTS preview_sha256,
    DROP COLUMN IF EXISTS correlation_id;

  ALTER TABLE public.quality_action
    DROP COLUMN IF EXISTS priority,
    DROP COLUMN IF EXISTS mandatory,
    DROP COLUMN IF EXISTS started_at,
    DROP COLUMN IF EXISTS completed_at,
    DROP COLUMN IF EXISTS evidence_required,
    DROP COLUMN IF EXISTS analysis_id,
    DROP COLUMN IF EXISTS correlation_id;

  ALTER TABLE public.quality_documents
    DROP COLUMN IF EXISTS revision,
    DROP COLUMN IF EXISTS confidentiality,
    DROP COLUMN IF EXISTS retention_until,
    DROP COLUMN IF EXISTS decision_evidence;

  ALTER TABLE public.quality_event_log
    DROP COLUMN IF EXISTS correlation_id,
    DROP COLUMN IF EXISTS idempotency_key,
    DROP COLUMN IF EXISTS rule_code,
    DROP COLUMN IF EXISTS reason,
    DROP COLUMN IF EXISTS request_id,
    DROP COLUMN IF EXISTS source;
END $$;

COMMIT;

-- Reminder: enum values added by #228 remain in place (PostgreSQL limitation).
SELECT t.typname AS enum_type, e.enumlabel AS value
FROM pg_type t
JOIN pg_enum e ON e.enumtypid = t.oid
WHERE t.typname IN ('quality_nc_status', 'quality_entity_type', 'quality_document_type')
ORDER BY t.typname, e.enumsortorder;
