\set ON_ERROR_STOP on
BEGIN TRANSACTION READ ONLY;
DO $verify$
DECLARE tab text;
BEGIN
  FOREACH tab IN ARRAY ARRAY['piece_version_preparation','of_preparation_evaluations','of_stock_reviews','of_self_inspection_sheets','piece_version_programming_tasks','of_stock_reuse_decisions','production_consolidations','production_consolidation_allocations','production_consolidation_receipt_allocations','production_consolidation_component_transfers'] LOOP
    IF to_regclass('public.'||tab) IS NULL THEN RAISE EXCEPTION 'Missing workbench table: %',tab; END IF;
  END LOOP;
  IF (SELECT count(*) FROM public.app_feature_flags WHERE key IN ('PRODUCTION_WORKBENCH','PRODUCTION_CONSOLIDATION'))<>2 THEN RAISE EXCEPTION 'Missing feature flags'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.ordres_fabrication'::regclass AND tgname='guard_covered_execution_712' AND tgenabled<>'D') OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.ordres_fabrication'::regclass AND tgname='guard_preparation_execution_712' AND tgenabled<>'D') THEN RAISE EXCEPTION 'Missing execution protections'; END IF;
  IF EXISTS(SELECT 1 FROM public.production_consolidations c JOIN public.ordres_fabrication o ON o.id=c.producer_of_id WHERE c.state='ACTIVE' AND o.quantite_lancee<>c.surplus_quantity+COALESCE((SELECT sum(a.quantity) FROM public.production_consolidation_allocations a WHERE a.consolidation_id=c.id AND a.state='ACTIVE'),0)) THEN RAISE EXCEPTION 'Producer quantity conservation failed'; END IF;
  IF EXISTS(SELECT 1 FROM public.production_consolidation_allocations WHERE state='ACTIVE' GROUP BY source_of_id HAVING count(*)>1) THEN RAISE EXCEPTION 'Duplicate coverage'; END IF;
  IF EXISTS(SELECT 1 FROM public.production_consolidation_allocations WHERE received_quantity<0 OR received_quantity>quantity) THEN RAISE EXCEPTION 'Receipt attribution exceeds demand'; END IF;
  IF EXISTS(SELECT 1 FROM public.of_self_inspection_sheets WHERE state='READY' AND (pdf IS NULL OR pdf_sha256 IS NULL)) THEN RAISE EXCEPTION 'Ready sheet without evidence'; END IF;
END $verify$;
SELECT key,enabled FROM public.app_feature_flags WHERE key IN ('PRODUCTION_WORKBENCH','PRODUCTION_CONSOLIDATION') ORDER BY key;
SELECT state,count(*) FROM public.production_consolidations GROUP BY state;
COMMIT;
