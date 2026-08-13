-- Read-only post-migration verification. Every boolean must be true.
SELECT
  to_regclass('public.stock_intelligence_policy_versions') IS NOT NULL AS policies_present,
  to_regclass('public.stock_intelligence_command_receipts') IS NOT NULL AS receipts_present,
  to_regprocedure('public.fn_stock_intelligence_evidence_append_only()') IS NOT NULL AS append_only_guard_present;

SELECT
  NOT EXISTS (
    SELECT 1 FROM public.stock_intelligence_policy_versions
    WHERE abc_a_cumulative_pct >= abc_b_cumulative_pct
       OR coverage_weeks NOT BETWEEN 1 AND 13
       OR inventory_absolute_tolerance_qty < 0
  ) AS policy_values_valid,
  NOT EXISTS (
    SELECT 1 FROM public.stock_intelligence_policy_versions
    GROUP BY valid_from HAVING count(*) > 1
  ) AS policy_dates_unique,
  NOT EXISTS (
    SELECT 1 FROM public.stock_intelligence_command_receipts
    WHERE request_hash !~ '^[0-9a-f]{64}$'
  ) AS receipt_hashes_valid;

SELECT table_name, privilege_type
FROM information_schema.role_table_grants
WHERE grantee = 'cerp_app'
  AND table_name LIKE 'stock_intelligence_%'
ORDER BY table_name, privilege_type;
