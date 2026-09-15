DO $$ DECLARE name text; BEGIN
  FOREACH name IN ARRAY ARRAY['planning_learning_jobs','planning_learning_state','planning_duration_predictions'] LOOP
    IF to_regclass('public.'||name) IS NULL THEN RAISE EXCEPTION 'Missing duration learning table: %',name; END IF;
  END LOOP;
  FOREACH name IN ARRAY ARRAY['production_pointages','production_quantity_declarations','planning_tasks','of_operations','of_revisions','ordres_fabrication','of_time_logs'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||name)::regclass
      AND tgname='planning_invalidate_learning' AND tgenabled='O') THEN RAISE EXCEPTION 'Missing invalidation trigger: %',name; END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM public.planning_estimation_observations o JOIN public.planning_learning_jobs j ON j.operation_id=o.operation_id
    WHERE o.measurement_kind='MACHINE' AND o.validated_at IS NOT NULL AND o.excluded_reason IS NULL) THEN
    RAISE EXCEPTION 'Pending source still eligible';
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='cerp_app') AND
    NOT has_table_privilege('cerp_app','public.planning_learning_jobs','INSERT,UPDATE,DELETE') THEN
    RAISE EXCEPTION 'Missing learning runtime grants';
  END IF;
END $$;
SELECT excluded_reason,count(*) FROM public.planning_estimation_observations
WHERE measurement_kind='MACHINE' GROUP BY excluded_reason ORDER BY excluded_reason NULLS FIRST;
SELECT s.*, (SELECT count(*) FROM public.planning_learning_jobs) AS pending FROM public.planning_learning_state s;
