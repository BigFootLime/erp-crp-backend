-- Preserve invalidation so a legacy write cannot silently validate a stale proposal.
UPDATE public.planning_central_settings SET activation='OBSERVE',updated_at=clock_timestamp() WHERE singleton;
