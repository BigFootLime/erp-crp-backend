\set ON_ERROR_STOP on
BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.production_machine_maintenance_events)
     OR EXISTS (SELECT 1 FROM public.production_machine_unavailability)
     OR EXISTS (SELECT 1 FROM public.production_machine_maintenance_plans)
     OR EXISTS (SELECT 1 FROM public.production_machine_idempotence) THEN
    RAISE EXCEPTION '#165 rollback refused: business rows exist; preserve industrial traceability';
  END IF;
END $$;

DROP TABLE IF EXISTS public.production_machine_maintenance_events;
DROP TABLE IF EXISTS public.production_machine_unavailability;
DROP TABLE IF EXISTS public.production_machine_maintenance_plans;
DROP TABLE IF EXISTS public.production_machine_idempotence;

-- The inert MCH whitelist entry, nullable rate semantics, immutable-code trigger and
-- additive document metadata are intentionally preserved by the safe rollback.
DELETE FROM public.cerp_schema_migrations
WHERE filename = '20260722_machine_park_165.sql'
  AND to_regclass('public.production_machine_unavailability') IS NULL;

COMMIT;
