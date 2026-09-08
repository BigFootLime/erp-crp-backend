\set ON_ERROR_STOP on
BEGIN READ ONLY;
SET LOCAL ROLE cerp_app;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.quality_control'::regclass AND conname='quality_control_context_v2_chk' AND convalidated)
     OR EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.quality_control'::regclass AND conname='quality_control_context_chk') THEN
    RAISE EXCEPTION 'Typed lot control constraint is not installed';
  END IF;
END $$;
SELECT count(*) AS retained_controls FROM public.quality_control;
COMMIT;
