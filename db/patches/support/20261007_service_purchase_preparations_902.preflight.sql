DO $$ BEGIN
  IF to_regclass('public.production_purchase_preparations') IS NULL
    OR to_regclass('public.production_purchase_preparation_events') IS NULL
    OR to_regclass('public.subcontract_purchase_origins') IS NULL
    OR to_regclass('public.production_consolidations') IS NULL
    THEN RAISE EXCEPTION 'Service preparation prerequisites missing'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.production_purchase_preparations'::regclass
    AND conname='production_purchase_preparations_kind_check' AND contype='c')
    THEN RAISE EXCEPTION 'Purchase kind constraint missing'; END IF;
  IF NOT has_table_privilege('cerp_app','public.production_purchase_preparations','SELECT,INSERT,UPDATE')
    OR NOT has_table_privilege('cerp_app','public.production_purchase_preparation_events','SELECT,INSERT')
    THEN RAISE EXCEPTION 'Service preparation runtime grants missing'; END IF;
END $$;
