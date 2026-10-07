DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.production_purchase_preparations'::regclass
    AND conname='production_purchase_preparations_kind_check' AND convalidated AND pg_get_constraintdef(oid) LIKE '%PRESTATION%')
    THEN RAISE EXCEPTION 'Service purchase kind missing'; END IF;
  IF EXISTS(SELECT 1 FROM public.production_purchase_preparations WHERE kind='PRESTATION'
    AND (mode<>'OF' OR of_id IS NULL OR source_ref IS NULL OR snapshot->'service'->'selection' IS NULL))
    THEN RAISE EXCEPTION 'Invalid service preparation identity'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.production_purchase_preparation_events'::regclass
    AND tgname='production_purchase_preparation_events_immutable' AND NOT tgisinternal AND tgenabled='O')
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.production_purchase_preparations'::regclass
    AND tgname='production_purchase_preparations_no_delete' AND NOT tgisinternal AND tgenabled='O')
    THEN RAISE EXCEPTION 'Service history protection missing'; END IF;
END $$;
