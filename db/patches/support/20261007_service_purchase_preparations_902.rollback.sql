-- Prefer a binary rollback, retaining the additive schema and recorded history.
BEGIN;
SET LOCAL lock_timeout='5s';
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM public.production_purchase_preparations WHERE kind='PRESTATION')
    OR EXISTS(SELECT 1 FROM public.production_purchase_preparation_events WHERE snapshot->>'kind'='PRESTATION')
    THEN RAISE EXCEPTION 'Service preparation history exists; preserve additive schema'; END IF;
END $$;
ALTER TABLE public.production_purchase_preparations DROP CONSTRAINT production_purchase_preparations_kind_check;
ALTER TABLE public.production_purchase_preparations ADD CONSTRAINT production_purchase_preparations_kind_check CHECK(kind IN ('MATIERE','CONSOMMABLE'));
DELETE FROM public.cerp_schema_migrations WHERE filename='20261007_service_purchase_preparations_902.sql';
COMMIT;
