-- Read-only post-migration verification. Every boolean must be true.
SELECT
  to_regclass('public.procurement_promised_date_events') IS NOT NULL AS promises_present,
  to_regclass('public.procurement_anomaly_actions') IS NOT NULL AS anomaly_actions_present,
  to_regclass('public.procurement_policy_versions') IS NOT NULL AS policies_present,
  to_regclass('public.procurement_command_receipts') IS NOT NULL AS command_receipts_present,
  to_regprocedure('public.fn_procurement_evidence_append_only()') IS NOT NULL AS append_only_guard_present;

SELECT
  NOT EXISTS (
    SELECT 1 FROM public.procurement_promised_date_events
    WHERE (reason_code <> 'SUPPLIER_ACKNOWLEDGEMENT' AND previous_date IS NOT DISTINCT FROM promised_date)
       OR (reason_code = 'OTHER' AND note IS NULL)
  ) AS promise_history_valid,
  NOT EXISTS (
    SELECT 1 FROM public.procurement_anomaly_actions
    WHERE status IN ('RESOLVED','DISMISSED') AND resolution_note IS NULL
  ) AS anomaly_closure_valid,
  NOT EXISTS (
    SELECT 1 FROM public.procurement_policy_versions
    GROUP BY scope_type, scope_id, valid_from HAVING count(*) > 1
  ) AS policy_versions_unique,
  NOT EXISTS (
    SELECT 1 FROM public.procurement_command_receipts
    WHERE request_hash !~ '^[0-9a-f]{64}$'
  ) AS receipt_hashes_valid;

SELECT table_name, privilege_type
FROM information_schema.role_table_grants
WHERE grantee = 'cerp_app'
  AND table_name LIKE 'procurement_%'
ORDER BY table_name, privilege_type;
