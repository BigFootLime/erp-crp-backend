DO $$ BEGIN
 IF to_regclass('public.production_machine_maintenance_plans') IS NULL
 OR to_regclass('public.production_machine_maintenance_events') IS NULL
 OR to_regclass('public.production_machine_documents') IS NULL
 OR to_regclass('public.production_machine_unavailability') IS NULL
 THEN RAISE EXCEPTION 'Canonical machine park is missing'; END IF;
 IF to_regclass('public.production_maintenance_receipts') IS NOT NULL THEN RAISE EXCEPTION 'Maintenance 867 is already installed'; END IF;
END $$;
