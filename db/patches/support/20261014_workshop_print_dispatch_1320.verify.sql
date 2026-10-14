BEGIN READ ONLY;
DO $$ BEGIN
  IF to_regclass('public.of_workshop_print_jobs') IS NULL OR to_regclass('public.of_workshop_print_receipts') IS NULL OR
    NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.planning_events'::regclass AND tgname='trg_workshop_event_dispatch_1320' AND tgenabled='O') OR
    NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.planning_tasks'::regclass AND tgname='trg_workshop_external_dispatch_1320' AND tgenabled='O') THEN
    RAISE EXCEPTION 'Workshop dispatch schema incomplete';
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='cerp_app') AND
    (NOT has_table_privilege('cerp_app','public.of_workshop_print_jobs','SELECT') OR NOT has_table_privilege('cerp_app','public.of_workshop_print_jobs','INSERT') OR
    NOT has_column_privilege('cerp_app','public.of_workshop_print_jobs','state','UPDATE') OR
    has_column_privilege('cerp_app','public.of_workshop_print_jobs','technical_sha256','UPDATE') OR
    has_table_privilege('cerp_app','public.of_workshop_print_jobs','DELETE') OR
    has_table_privilege('cerp_app','public.of_workshop_print_receipts','UPDATE,DELETE')) THEN
    RAISE EXCEPTION 'Workshop dispatch application privileges incorrect';
  END IF;
  IF EXISTS(SELECT 1 FROM public.of_workshop_print_receipts r JOIN public.of_workshop_print_jobs j ON j.id=r.job_id
    WHERE r.intent_id<>j.print_intent_id OR r.actor_id<>j.claimed_by OR r.device_id<>j.device_id) THEN
    RAISE EXCEPTION 'Workshop dispatch receipt scope inconsistent';
  END IF;
END $$;
SELECT json_build_object('jobs',count(*),'spooled',count(*) FILTER(WHERE state='SPOOLED'),'review',count(*) FILTER(WHERE state='REVIEW')) FROM public.of_workshop_print_jobs;
ROLLBACK;
