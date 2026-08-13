-- Guarded rollback for an empty, unused SOL-19 policy feature only.
-- If any row exists, restore the verified pre-migration backup into a fresh
-- database and promote it; never erase industrial decision evidence in place.
BEGIN;
DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM public.stock_intelligence_policy_versions)
     OR EXISTS (SELECT 1 FROM public.stock_intelligence_command_receipts) THEN
    RAISE EXCEPTION 'SOL-19 rollback refused: policy evidence exists; restore the pre-migration backup into a fresh database';
  END IF;
END
$guard$;

DROP TABLE public.stock_intelligence_command_receipts;
DROP TABLE public.stock_intelligence_policy_versions;
DROP FUNCTION public.fn_stock_intelligence_evidence_append_only();
DELETE FROM public.cerp_schema_migrations WHERE filename = '20260813_stock_intelligence_sol19.sql';
COMMIT;
