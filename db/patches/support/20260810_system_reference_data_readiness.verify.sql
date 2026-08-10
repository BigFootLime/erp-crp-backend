\set ON_ERROR_STOP on

BEGIN TRANSACTION READ ONLY;

DO $verify$
BEGIN
  IF to_regprocedure('public.fn_business_prerequisite_status(text)') IS NULL
     OR to_regprocedure('public.fn_enforce_business_prerequisites()') IS NULL THEN
    RAISE EXCEPTION 'SOL-06 verify: readiness functions are missing';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_stock_reference_readiness_2606' AND tgenabled <> 'D')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_production_reference_readiness_2606' AND tgenabled <> 'D')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_planning_reference_readiness_2606' AND tgenabled <> 'D') THEN
    RAISE EXCEPTION 'SOL-06 verify: one or more business-flow readiness triggers are missing or disabled';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.fn_business_prerequisite_status('STOCK') WHERE NOT ready
    UNION ALL
    SELECT 1 FROM public.fn_business_prerequisite_status('PLANNING') WHERE NOT ready
    UNION ALL
    SELECT 1 FROM public.fn_business_prerequisite_status('PRODUCTION') WHERE NOT ready
  ) THEN
    RAISE EXCEPTION 'SOL-06 verify: reference-data readiness contains blocking findings';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE connamespace = 'public'::regnamespace AND contype = 'f' AND NOT convalidated
  ) THEN
    RAISE EXCEPTION 'SOL-06 verify: public foreign keys remain NOT VALID';
  END IF;
END
$verify$;

SELECT * FROM public.fn_business_prerequisite_status('STOCK');
SELECT * FROM public.fn_business_prerequisite_status('PLANNING');
SELECT * FROM public.fn_business_prerequisite_status('PRODUCTION');

COMMIT;
