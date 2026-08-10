\set ON_ERROR_STOP on

DO $guard$
BEGIN
  IF current_database() <> 'cerp_test'
     OR current_setting('cerp.migration_rehearsal', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'SOL-06 rollback is test-only: cerp_test plus SET cerp.migration_rehearsal = on required';
  END IF;
END
$guard$;

BEGIN;

DROP TRIGGER IF EXISTS trg_stock_reference_readiness_2606 ON public.stock_movements;
DROP TRIGGER IF EXISTS trg_production_reference_readiness_2606 ON public.ordres_fabrication;
DROP TRIGGER IF EXISTS trg_planning_reference_readiness_2606 ON public.programmations;
DROP FUNCTION IF EXISTS public.fn_enforce_business_prerequisites();
DROP FUNCTION IF EXISTS public.fn_business_prerequisite_status(text);

ALTER TABLE public.erp_settings
  DROP CONSTRAINT IF EXISTS erp_settings_reference_period_ck,
  DROP CONSTRAINT IF EXISTS erp_settings_reference_reliability_ck,
  DROP COLUMN IF EXISTS definition,
  DROP COLUMN IF EXISTS unit,
  DROP COLUMN IF EXISTS period_start,
  DROP COLUMN IF EXISTS period_end,
  DROP COLUMN IF EXISTS source,
  DROP COLUMN IF EXISTS freshness_at,
  DROP COLUMN IF EXISTS reliability;

COMMIT;
