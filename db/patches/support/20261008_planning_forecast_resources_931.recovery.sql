-- Read-only diagnosis; the durable worker retries outstanding invalidations.
SELECT calculated_at,source_revision,issue_count,last_error FROM public.planning_forecast_state WHERE singleton;
SELECT count(*) AS pending_recalculations FROM public.planning_recalculation_jobs WHERE processed_at IS NULL;
