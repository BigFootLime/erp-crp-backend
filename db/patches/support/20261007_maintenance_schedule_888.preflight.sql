DO $$ BEGIN
 IF to_regclass('public.production_machine_unavailability') IS NULL
 OR to_regclass('public.production_machine_maintenance_events') IS NULL
 OR to_regclass('public.planning_central_settings') IS NULL
 OR to_regprocedure('public.prevent_material_debit_rewrite()') IS NULL
 OR to_regprocedure('public.planning_invalidate()') IS NULL
 THEN RAISE EXCEPTION 'Canonical maintenance/planning prerequisites missing'; END IF;
 IF to_regclass('public.production_maintenance_schedules') IS NOT NULL
 THEN RAISE EXCEPTION 'Maintenance calendar 888 already installed'; END IF;
END $$;
