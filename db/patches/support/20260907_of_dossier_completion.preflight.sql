\set ON_ERROR_STOP on
BEGIN READ ONLY;
SELECT current_database() AS database,current_user AS actor;
DO $$ DECLARE relation text; BEGIN
  FOREACH relation IN ARRAY ARRAY['ordres_fabrication','of_operations','of_revisions','planning_events','planning_tasks','planning_central_settings','of_preparation_evaluations','app_feature_flags','commande_ligne','cerp_schema_migrations'] LOOP
    IF to_regclass('public.'||relation) IS NULL THEN RAISE EXCEPTION 'Missing prerequisite: %',relation; END IF;
  END LOOP;
END $$;
SELECT statut,count(*) FROM public.ordres_fabrication GROUP BY statut ORDER BY statut;
SELECT key,enabled FROM public.app_feature_flags WHERE key='PRODUCTION_MATERIAL_WORKFLOW';
COMMIT;
