-- Stop the new runtime first. An additive schema can safely remain on binary rollback.
-- This optional schema withdrawal refuses to erase any recorded preparation or history.
BEGIN;
DO $$ BEGIN
  IF to_regclass('public.production_purchase_preparation_events') IS NOT NULL THEN
    IF EXISTS(SELECT 1 FROM public.production_purchase_preparation_events) THEN RAISE EXCEPTION 'Purchase preparation history exists; preserve the additive schema'; END IF;
  END IF;
  IF to_regclass('public.production_purchase_preparations') IS NOT NULL THEN
    IF EXISTS(SELECT 1 FROM public.production_purchase_preparations) THEN RAISE EXCEPTION 'Purchase preparations exist; preserve the additive schema'; END IF;
  END IF;
END $$;
DROP TABLE IF EXISTS public.production_purchase_preparation_events;
DROP TABLE IF EXISTS public.production_purchase_preparations;
DELETE FROM public.cerp_schema_migrations WHERE filename='20261007_purchase_preparations_902.sql';
COMMIT;
