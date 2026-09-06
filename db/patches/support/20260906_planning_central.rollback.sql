-- Compensating feature deactivation. Preserve committed canonical events and all history.
UPDATE public.planning_central_settings SET activation='OBSERVE',updated_at=clock_timestamp() WHERE singleton;
-- Redeploy the recorded previous frontend/backend artifacts. No schema/data deletion is needed.
