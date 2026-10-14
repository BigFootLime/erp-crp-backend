BEGIN;
SET LOCAL lock_timeout='5s';
LOCK TABLE public.quality_autocontrol_capture IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF current_setting('cerp.rollback_ack',true) IS DISTINCT FROM '1328-empty-autocontrol-reviewed' THEN RAISE EXCEPTION 'Autocontrol rollback requires reviewed acknowledgement'; END IF;
  IF EXISTS(SELECT 1 FROM public.quality_autocontrol_capture) THEN RAISE EXCEPTION 'Autocontrol rollback refused: paper evidence is retained'; END IF;
END $$;
DROP TRIGGER trg_guard_autocontrol_measurement_1328 ON public.quality_control_points;
DROP TRIGGER trg_guard_autocontrol_scope_1328 ON public.quality_control;
DROP TRIGGER trg_protect_autocontrol_scan_1328 ON public.quality_documents;
DROP TABLE public.quality_autocontrol_capture;
DROP FUNCTION public.fn_guard_autocontrol_capture_1328(),public.fn_protect_autocontrol_scan_1328(),public.fn_guard_autocontrol_measurement_1328(),public.fn_guard_autocontrol_scope_1328();
COMMIT;
