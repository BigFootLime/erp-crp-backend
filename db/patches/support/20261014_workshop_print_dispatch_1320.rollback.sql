BEGIN;
SET LOCAL lock_timeout='5s';
DO $$ BEGIN
  IF current_setting('cerp.rollback_ack',true) IS DISTINCT FROM '1320-empty-dispatch-model-reviewed' THEN
    RAISE EXCEPTION 'Workshop dispatch rollback requires explicit reviewed acknowledgement';
  END IF;
  IF EXISTS(SELECT 1 FROM public.of_workshop_print_jobs) OR EXISTS(SELECT 1 FROM public.of_workshop_print_receipts) THEN
    RAISE EXCEPTION 'Workshop dispatch contains saved evidence; restore must preserve it';
  END IF;
END $$;
DROP TRIGGER IF EXISTS trg_workshop_event_dispatch_1320 ON public.planning_events;
DROP TRIGGER IF EXISTS trg_workshop_external_dispatch_1320 ON public.planning_tasks;
DROP TABLE public.of_workshop_print_receipts;
DROP TABLE public.of_workshop_print_jobs;
DROP FUNCTION public.fn_workshop_event_dispatch_1320();
DROP FUNCTION public.fn_workshop_external_dispatch_1320();
DROP FUNCTION public.fn_queue_workshop_edition_1320(bigint,text,text,integer);
DROP FUNCTION public.fn_workshop_job_guard_1320();
COMMIT;
