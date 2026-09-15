-- Read-only. Run on the approved target before applying the patch.
SELECT current_database(),current_user,version();
SELECT activation,revision FROM public.planning_central_settings WHERE singleton;
SELECT to_regclass('public.production_pointages') AS pointages,
  to_regclass('public.production_quantity_declarations') AS declarations,
  to_regclass('public.planning_estimation_observations') AS observations,
  to_regclass('public.planning_recalculation_jobs') AS forecasts;
SELECT count(*) AS completed_operations FROM public.of_operations WHERE status='DONE';
SELECT count(*) AS historical_segments_without_mapping FROM public.of_time_logs WHERE pointage_id IS NULL;
-- Any repeated correction target must be reconciled before creating the unique index.
SELECT new_values->>'corrects' AS target,count(*)
FROM public.production_pointage_events WHERE event_type='CORRECT' AND new_values ? 'corrects'
GROUP BY new_values->>'corrects' HAVING count(*)>1;
