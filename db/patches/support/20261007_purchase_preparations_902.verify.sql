DO $$ BEGIN
  IF to_regclass('public.production_purchase_preparations') IS NULL OR to_regclass('public.production_purchase_preparation_events') IS NULL
    THEN RAISE EXCEPTION 'Purchase preparation tables missing'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.production_purchase_preparation_events'::regclass
    AND tgname='production_purchase_preparation_events_immutable' AND NOT tgisinternal AND tgenabled='O')
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.production_purchase_preparations'::regclass
    AND tgname='production_purchase_preparations_no_delete' AND NOT tgisinternal AND tgenabled='O')
    THEN RAISE EXCEPTION 'Purchase preparation history protection missing'; END IF;
  IF NOT has_table_privilege('cerp_app','public.production_purchase_preparations','SELECT,INSERT,UPDATE')
    OR NOT has_table_privilege('cerp_app','public.production_purchase_preparation_events','SELECT,INSERT')
    THEN RAISE EXCEPTION 'Purchase preparation runtime grants missing'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.production_purchase_preparations'::regclass
    AND contype='u' AND pg_get_constraintdef(oid)='UNIQUE (scope_key)')
    THEN RAISE EXCEPTION 'Purchase preparation duplicate protection missing'; END IF;
  IF EXISTS(SELECT 1 FROM public.production_purchase_preparations
    WHERE mode='GLOBAL_PACK' AND (of_id IS NOT NULL OR need_id IS NOT NULL OR article_id IS NULL))
    THEN RAISE EXCEPTION 'Global preparations must not allocate an OF'; END IF;
END $$;
