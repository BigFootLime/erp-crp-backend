DO $$ DECLARE n integer; BEGIN
 SELECT count(*) INTO n FROM pg_tables WHERE schemaname='public' AND tablename IN ('production_maintenance_authorizations','production_maintenance_receipts','production_maintenance_holds','production_maintenance_counter_readings','production_maintenance_commands');
 IF n<>5 THEN RAISE EXCEPTION 'Maintenance tables are incomplete'; END IF;
 SELECT count(*) INTO n FROM pg_trigger WHERE NOT tgisinternal AND tgname IN ('production_maintenance_authorizations_immutable_867','production_maintenance_receipts_immutable_867','production_maintenance_counter_readings_immutable_867','production_maintenance_commands_immutable_867','production_maintenance_holds_guard_867','production_maintenance_evidence_guard_867','production_maintenance_event_guard_867');
 IF n<>7 THEN RAISE EXCEPTION 'Maintenance preservation guards are incomplete'; END IF;
 IF NOT has_table_privilege('cerp_app','public.production_maintenance_receipts','INSERT') OR has_table_privilege('cerp_app','public.production_maintenance_receipts','DELETE') THEN RAISE EXCEPTION 'Maintenance privileges are incorrect'; END IF;
END $$;
