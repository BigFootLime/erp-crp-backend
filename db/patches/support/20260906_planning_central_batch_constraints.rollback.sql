-- Existing callers still check these constraints immediately. Keep the exclusions intact.
UPDATE public.planning_central_settings SET activation='OBSERVE',updated_at=clock_timestamp() WHERE singleton;
