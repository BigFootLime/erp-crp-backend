\set ON_ERROR_STOP on
DO $$ BEGIN
  IF to_regclass('public.stock_material_bars') IS NULL OR to_regclass('public.stock_material_bar_events') IS NULL
    OR to_regprocedure('public.protect_material_bar_identity_1246()') IS NULL THEN
    RAISE EXCEPTION 'Apply physical material bars #1246 before movement support';
  END IF;
  IF EXISTS (SELECT name FROM unnest(ARRAY['id','article_id','stock_batch_id','qty','status','movement_type','doc_type','doc_id']) AS name
    EXCEPT SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='stock_movements') THEN
    RAISE EXCEPTION 'Canonical stock movement columns are incomplete';
  END IF;
END $$;
