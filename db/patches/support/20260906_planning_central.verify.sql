DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.planning_central_settings WHERE singleton) THEN
    RAISE EXCEPTION 'Planning central settings missing';
  END IF;
  IF EXISTS(SELECT 1 FROM public.of_operations o WHERE NOT EXISTS(
    SELECT 1 FROM public.planning_tasks t WHERE t.operation_id=o.id)) THEN
    RAISE EXCEPTION 'Canonical operation missing from planning metadata';
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='cerp_app') AND
    NOT has_table_privilege('cerp_app','public.planning_recalculation_jobs','INSERT') THEN
    RAISE EXCEPTION 'Planning runtime grants missing';
  END IF;
END $$;
