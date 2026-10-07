DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['production_maintenance_schedules','production_maintenance_schedule_revisions','production_maintenance_schedule_occurrences'] LOOP
  IF to_regclass('public.'||t) IS NULL THEN RAISE EXCEPTION 'Missing maintenance calendar table %',t; END IF;
  IF NOT has_table_privilege('cerp_app','public.'||t,'SELECT') OR NOT has_table_privilege('cerp_app','public.'||t,'INSERT')
  THEN RAISE EXCEPTION 'Missing maintenance calendar runtime privilege %',t; END IF;
  IF has_table_privilege('cerp_app','public.'||t,'DELETE') OR has_table_privilege('cerp_app','public.'||t,'TRUNCATE')
  THEN RAISE EXCEPTION 'Unsafe maintenance calendar runtime privilege %',t; END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.production_maintenance_schedules'::regclass
  AND conname='maintenance_schedule_current_revision_888' AND condeferrable AND condeferred AND convalidated)
 THEN RAISE EXCEPTION 'Missing deferred current maintenance revision'; END IF;
 IF (SELECT count(*) FROM pg_trigger WHERE tgname IN('maintenance_schedule_revisions_immutable_888','maintenance_schedule_occurrences_immutable_888','maintenance_schedule_guard_888') AND tgenabled='O')<>3
 THEN RAISE EXCEPTION 'Missing immutable maintenance calendar guards'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.production_maintenance_schedules'::regclass AND tgname='planning_invalidate' AND tgenabled='O')
 THEN RAISE EXCEPTION 'Missing central capacity invalidation'; END IF;
 IF NOT has_column_privilege('cerp_app','public.production_maintenance_schedules','version','UPDATE')
 OR has_column_privilege('cerp_app','public.production_maintenance_schedules','kind','UPDATE')
 OR has_table_privilege('cerp_app','public.production_maintenance_schedule_revisions','UPDATE')
 OR has_table_privilege('cerp_app','public.production_maintenance_schedule_occurrences','UPDATE')
 THEN RAISE EXCEPTION 'Unsafe maintenance revision update privileges'; END IF;
END $$;
