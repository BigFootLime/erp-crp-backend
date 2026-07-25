\set ON_ERROR_STOP on

-- Read-only preflight for issue #228 (Qualité industrielle 360).
-- It changes nothing and never enables a quality decision.
DO $$
BEGIN
  IF current_database() <> 'cerp_test' THEN
    RAISE EXCEPTION '#228 preflight is restricted to cerp_test';
  END IF;
END $$;

SELECT current_database() AS database_name, current_user AS database_user, now() AS checked_at;
SELECT current_setting('server_version') AS server_version;

-- 1) Prerequisites the forward patch relies on.
SELECT prerequisite, present
FROM (
  VALUES
    ('quality_control', to_regclass('public.quality_control') IS NOT NULL),
    ('quality_control_points', to_regclass('public.quality_control_points') IS NOT NULL),
    ('quality_documents', to_regclass('public.quality_documents') IS NOT NULL),
    ('quality_event_log', to_regclass('public.quality_event_log') IS NOT NULL),
    ('quality_action', to_regclass('public.quality_action') IS NOT NULL),
    ('non_conformity', to_regclass('public.non_conformity') IS NOT NULL),
    ('non_conformity_dispositions', to_regclass('public.non_conformity_dispositions') IS NOT NULL),
    ('users', to_regclass('public.users') IS NOT NULL),
    ('lots', to_regclass('public.lots') IS NOT NULL),
    ('metrologie_equipements', to_regclass('public.metrologie_equipements') IS NOT NULL),
    ('reception_fournisseur_lignes', to_regclass('public.reception_fournisseur_lignes') IS NOT NULL),
    ('reception_incoming_inspections', to_regclass('public.reception_incoming_inspections') IS NOT NULL),
    ('gen_random_uuid', to_regprocedure('gen_random_uuid()') IS NOT NULL),
    ('tg_set_updated_at', to_regprocedure('public.tg_set_updated_at()') IS NOT NULL)
) AS checks(prerequisite, present)
ORDER BY prerequisite;

-- 2) Objects the patch would create (must all be absent before the first run).
SELECT target, already_present
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
) AS targets(target, already_present)
ORDER BY target;

-- 3) Enum values that the patch extends additively.
SELECT t.typname AS enum_type, e.enumlabel AS value, e.enumsortorder
FROM pg_type t
JOIN pg_enum e ON e.enumtypid = t.oid
WHERE t.typname IN ('quality_nc_status', 'quality_entity_type', 'quality_document_type')
ORDER BY t.typname, e.enumsortorder;

-- 4) Volume actually impacted by the additive columns (rewrite window).
SELECT 'quality_control' AS table_name, COUNT(*)::bigint AS rows FROM public.quality_control
UNION ALL SELECT 'quality_control_points', COUNT(*)::bigint FROM public.quality_control_points
UNION ALL SELECT 'non_conformity', COUNT(*)::bigint FROM public.non_conformity
UNION ALL SELECT 'non_conformity_dispositions', COUNT(*)::bigint FROM public.non_conformity_dispositions
UNION ALL SELECT 'quality_action', COUNT(*)::bigint FROM public.quality_action
UNION ALL SELECT 'quality_documents', COUNT(*)::bigint FROM public.quality_documents
UNION ALL SELECT 'quality_event_log', COUNT(*)::bigint FROM public.quality_event_log
ORDER BY table_name;

-- 5) Existing data that would violate the new quantity ledger constraints.
--    Expected: zero rows. The patch adds the constraints NOT VALID then
--    validates them, so a non-empty result here is a stop signal.
SELECT id, status, result
FROM public.quality_control
WHERE FALSE -- placeholder: new quantity columns do not exist before the patch
LIMIT 0;

-- 6) Dispositions using a type outside the extended CHECK list.
SELECT DISTINCT disposition_type
FROM public.non_conformity_dispositions
WHERE disposition_type NOT IN (
  'HOLD', 'RELEASE', 'USE_AS_IS', 'REWORK', 'SORT', 'SCRAP', 'RETURN_SUPPLIER', 'RECHECK'
)
ORDER BY disposition_type;

-- 7) Documents whose identity columns are incomplete (hash immutability trigger).
SELECT COUNT(*)::bigint AS quality_documents_without_sha256
FROM public.quality_documents
WHERE sha256 IS NULL AND removed_at IS NULL;

-- 8) Reception quality overlap to consolidate later (read-only observation).
SELECT COUNT(*)::bigint AS reception_incoming_inspections
FROM public.reception_incoming_inspections;
