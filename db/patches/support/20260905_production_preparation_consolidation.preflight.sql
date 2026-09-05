\set ON_ERROR_STOP on
BEGIN TRANSACTION READ ONLY;
DO $preflight$
DECLARE tab text;
BEGIN
  FOREACH tab IN ARRAY ARRAY['ordres_fabrication','of_operations','piece_technique_versions','pieces_techniques_achats','pieces_techniques_nomenclature','quality_control_plan','stock_reservations','of_component_requirements','app_feature_flags','planning_events','of_receipts'] LOOP
    IF to_regclass('public.'||tab) IS NULL THEN RAISE EXCEPTION 'Missing prerequisite: %',tab; END IF;
  END LOOP;
  IF to_regclass('public.v_stock_availability_225') IS NULL THEN RAISE EXCEPTION 'Canonical stock availability is missing'; END IF;
END $preflight$;
SELECT statut, count(*) AS orders, count(*) FILTER(WHERE piece_technique_version_id IS NULL) AS without_pinned_revision FROM public.ordres_fabrication GROUP BY statut;
SELECT count(*) AS historical_purchase_rows FROM public.pieces_techniques_achats;
COMMIT;
