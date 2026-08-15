\set ON_ERROR_STOP on

SELECT to_regclass('public.reference_data_change_sets') IS NOT NULL AS change_sets_present,
       to_regclass('public.reference_data_versions') IS NOT NULL AS versions_present,
       to_regclass('public.reference_data_decisions') IS NOT NULL AS decisions_present,
       to_regprocedure('public.fn_reference_data_version_guard()') IS NOT NULL AS version_guard_present,
       to_regprocedure('public.fn_reference_data_decision_append_only()') IS NOT NULL AS decision_guard_present;

SELECT
  (SELECT count(*) FROM public.reference_data_change_sets) AS change_sets,
  (SELECT count(*) FROM public.reference_data_versions) AS versions,
  (SELECT count(*) FROM public.reference_data_decisions) AS decisions,
  (SELECT count(*) FROM public.reference_data_versions v
    JOIN public.reference_data_versions other
      ON other.dataset_code = v.dataset_code AND other.record_key = v.record_key AND other.id > v.id
     AND v.effective_to IS NOT NULL AND other.effective_to IS NOT NULL
     AND daterange(other.effective_from, COALESCE(other.effective_to + 1, 'infinity'::date), '[)')
         && daterange(v.effective_from, COALESCE(v.effective_to + 1, 'infinity'::date), '[)')) AS overlapping_versions;

SELECT table_name, privilege_type
FROM information_schema.role_table_grants
WHERE grantee = 'cerp_app'
  AND table_name IN ('reference_data_change_sets','reference_data_versions','reference_data_decisions')
ORDER BY table_name, privilege_type;
