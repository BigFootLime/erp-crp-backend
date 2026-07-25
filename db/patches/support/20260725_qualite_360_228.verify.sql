\set ON_ERROR_STOP on

-- Read-only verification for issue #228 after applying the forward patch.
DO $$
BEGIN
  IF current_database() <> 'cerp_test' THEN
    RAISE EXCEPTION '#228 verify is restricted to cerp_test';
  END IF;
END $$;

SELECT current_database() AS database_name, now() AS verified_at;

-- 1) Tables created.
SELECT object_name, present
FROM (
  VALUES
    ('quality_control_plan', to_regclass('public.quality_control_plan') IS NOT NULL),
    ('quality_control_plan_characteristic', to_regclass('public.quality_control_plan_characteristic') IS NOT NULL),
    ('quality_measurement_revisions', to_regclass('public.quality_measurement_revisions') IS NOT NULL),
    ('quality_release_decision', to_regclass('public.quality_release_decision') IS NOT NULL),
    ('quality_derogation', to_regclass('public.quality_derogation') IS NOT NULL),
    ('quality_derogation_consumption', to_regclass('public.quality_derogation_consumption') IS NOT NULL),
    ('non_conformity_analysis', to_regclass('public.non_conformity_analysis') IS NOT NULL),
    ('quality_command_receipts', to_regclass('public.quality_command_receipts') IS NOT NULL)
) AS checks(object_name, present)
ORDER BY object_name;

-- 2) Additive columns on existing tables.
SELECT table_name, column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND (
    (table_name = 'quality_control' AND column_name IN (
      'plan_id', 'plan_version', 'plan_snapshot', 'plan_snapshot_sha256', 'source_type', 'source_id',
      'verdict', 'verdict_computed', 'unite', 'qty_population', 'qty_controlled', 'qty_conforming',
      'qty_released', 'qty_held', 'qty_scrapped', 'qty_reworked', 'qty_sorted', 'qty_returned',
      'qty_consumed', 'correlation_id', 'reception_inspection_id'))
    OR (table_name = 'quality_control_points' AND column_name IN (
      'characteristic_key', 'sample_no', 'value_boolean', 'value_text', 'instrument_id',
      'instrument_snapshot', 'evaluation_code', 'criticality', 'revision'))
    OR (table_name = 'non_conformity' AND column_name IN (
      'origin', 'defect_category', 'qty', 'unite', 'owner_user_id', 'confidentiality',
      'capa_required', 'reopened_at', 'cancelled_at', 'correlation_id'))
    OR (table_name = 'non_conformity_dispositions' AND column_name IN (
      'derogation_id', 'quality_control_id', 'instructions', 'idempotency_key', 'preview_sha256'))
    OR (table_name = 'quality_action' AND column_name IN (
      'priority', 'mandatory', 'started_at', 'completed_at', 'evidence_required', 'analysis_id'))
    OR (table_name = 'quality_documents' AND column_name IN (
      'revision', 'confidentiality', 'retention_until', 'decision_evidence'))
    OR (table_name = 'quality_event_log' AND column_name IN (
      'correlation_id', 'idempotency_key', 'rule_code', 'reason', 'request_id', 'source'))
  )
ORDER BY table_name, column_name;

-- 3) Extended enum values are present (historical values must remain first).
SELECT t.typname AS enum_type, e.enumlabel AS value, e.enumsortorder
FROM pg_type t
JOIN pg_enum e ON e.enumtypid = t.oid
WHERE t.typname IN ('quality_nc_status', 'quality_entity_type', 'quality_document_type')
ORDER BY t.typname, e.enumsortorder;

-- 4) Guard triggers installed.
SELECT c.relname AS table_name, t.tgname AS trigger_name, NOT t.tgisinternal AS user_trigger
FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
WHERE NOT t.tgisinternal
  AND t.tgname LIKE '%\_228'
ORDER BY c.relname, t.tgname;

-- 5) Quantity ledger constraints are VALID (not left NOT VALID).
SELECT conname, convalidated
FROM pg_constraint
WHERE conname IN (
  'quality_control_qty_nonneg_228_ck',
  'quality_control_qty_ledger_228_ck',
  'non_conformity_dispositions_type_check'
)
ORDER BY conname;

-- 6) Uniqueness guarantees.
SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname IN (
    'quality_control_points_sample_228_uq',
    'non_conformity_dispositions_idem_228_uq',
    'quality_command_receipts_resource_228_idx'
  )
ORDER BY indexname;

-- 7) The patch stays inactive: no plan, no derogation, no release decision.
SELECT 'quality_control_plan' AS table_name, COUNT(*)::bigint AS rows FROM public.quality_control_plan
UNION ALL SELECT 'quality_control_plan_characteristic', COUNT(*)::bigint FROM public.quality_control_plan_characteristic
UNION ALL SELECT 'quality_derogation', COUNT(*)::bigint FROM public.quality_derogation
UNION ALL SELECT 'quality_derogation_consumption', COUNT(*)::bigint FROM public.quality_derogation_consumption
UNION ALL SELECT 'quality_release_decision', COUNT(*)::bigint FROM public.quality_release_decision
UNION ALL SELECT 'quality_measurement_revisions', COUNT(*)::bigint FROM public.quality_measurement_revisions
UNION ALL SELECT 'non_conformity_analysis', COUNT(*)::bigint FROM public.non_conformity_analysis
UNION ALL SELECT 'quality_command_receipts', COUNT(*)::bigint FROM public.quality_command_receipts
ORDER BY table_name;

-- 8) Historical quality data untouched: no lot status was changed by the patch.
SELECT lot_status, COUNT(*)::bigint AS rows
FROM public.lots
GROUP BY lot_status
ORDER BY lot_status;

-- 9) Historical controls keep their result and validation identity.
SELECT status, result, COUNT(*)::bigint AS rows
FROM public.quality_control
GROUP BY status, result
ORDER BY status, result;
