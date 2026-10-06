DO $$ BEGIN
  IF to_regclass('public.delivery_promise_roots') IS NULL OR to_regclass('public.delivery_promise_parts') IS NULL
    OR to_regclass('public.delivery_promise_events') IS NULL OR to_regclass('public.delivery_promise_shipments') IS NULL
    OR to_regprocedure('public.capture_initial_delivery_promises(bigint)') IS NULL
    OR to_regprocedure('public.workshop_working_deadline(timestamp with time zone,numeric)') IS NULL THEN
    RAISE EXCEPTION 'Incomplete L3 schema';
  END IF;
  IF EXISTS(SELECT 1 FROM public.delivery_promise_roots r WHERE r.initial_quantity<=0
    OR NOT EXISTS(SELECT 1 FROM public.delivery_promise_parts p WHERE p.root_id=r.id)) THEN
    RAISE EXCEPTION 'Invalid initial commercial promise';
  END IF;
END $$;
SELECT count(*) AS initial_promises FROM public.delivery_promise_roots;
-- Compile the stored functions' SQL even on an empty isolated schema.
SELECT public.capture_initial_delivery_promises(NULL::bigint);
SELECT public.workshop_working_deadline(now(),48),public.workshop_delay_days(CURRENT_DATE,CURRENT_DATE);
