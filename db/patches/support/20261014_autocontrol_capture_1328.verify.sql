DO $$ BEGIN
  IF to_regclass('public.quality_autocontrol_capture') IS NULL THEN RAISE EXCEPTION 'Autocontrol table missing'; END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgenabled='O' AND
    ((tgrelid='public.quality_autocontrol_capture'::regclass AND tgname='trg_guard_autocontrol_capture_1328' AND tgfoid='public.fn_guard_autocontrol_capture_1328()'::regprocedure)
    OR (tgrelid='public.quality_documents'::regclass AND tgname='trg_protect_autocontrol_scan_1328' AND tgfoid='public.fn_protect_autocontrol_scan_1328()'::regprocedure)
    OR (tgrelid='public.quality_control_points'::regclass AND tgname='trg_guard_autocontrol_measurement_1328' AND tgfoid='public.fn_guard_autocontrol_measurement_1328()'::regprocedure)
    OR (tgrelid='public.quality_control'::regclass AND tgname='trg_guard_autocontrol_scope_1328' AND tgfoid='public.fn_guard_autocontrol_scope_1328()'::regprocedure)))<>4 THEN
    RAISE EXCEPTION 'Autocontrol canonical guards missing';
  END IF;
  IF NOT has_table_privilege('cerp_app','public.quality_autocontrol_capture','SELECT,INSERT,UPDATE,DELETE') THEN RAISE EXCEPTION 'Autocontrol application grant missing'; END IF;
END $$;
SELECT 'Autocontrol model and exact guards verified' AS result;
