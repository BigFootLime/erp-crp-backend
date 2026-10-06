-- L3: immutable initial acknowledgement, versioned commercial promises and shipment evidence.
BEGIN;
ALTER TABLE public.planning_central_settings ADD COLUMN IF NOT EXISTS workshop_calendar_id uuid
  REFERENCES public.programmation_calendars(id);

CREATE TABLE IF NOT EXISTS public.delivery_promise_roots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  allocation_id bigint NOT NULL UNIQUE REFERENCES public.commande_ligne_affaire_allocation(id),
  commande_id bigint NOT NULL REFERENCES public.commande_client(id),
  line_id bigint NOT NULL REFERENCES public.commande_ligne(id),
  affaire_id bigint NOT NULL REFERENCES public.affaire(id),
  ar_id uuid NOT NULL REFERENCES public.commande_ar_log(id),
  initial_quantity numeric NOT NULL CHECK(initial_quantity>0),
  initial_due_date date NOT NULL,
  initial_snapshot jsonb NOT NULL,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.delivery_promise_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), root_id uuid NOT NULL REFERENCES public.delivery_promise_roots(id),
  actor_id integer NOT NULL REFERENCES public.users(id), request_key text NOT NULL,
  request jsonb NOT NULL, reason text NOT NULL CHECK(length(btrim(reason))>=5),
  before_parts jsonb NOT NULL, after_parts jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(actor_id,request_key)
);
CREATE TABLE IF NOT EXISTS public.delivery_promise_parts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), root_id uuid NOT NULL REFERENCES public.delivery_promise_roots(id),
  quantity numeric NOT NULL CHECK(quantity>0), due_date date NOT NULL,
  revision_event_id uuid REFERENCES public.delivery_promise_events(id),
  retired_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS delivery_promise_parts_active ON public.delivery_promise_parts(root_id) WHERE retired_at IS NULL;
CREATE TABLE IF NOT EXISTS public.delivery_promise_shipments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), part_id uuid NOT NULL REFERENCES public.delivery_promise_parts(id),
  bl_allocation_id uuid NOT NULL REFERENCES public.bon_livraison_ligne_allocations(id),
  quantity numeric NOT NULL CHECK(quantity>0), due_date_at_shipment date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(part_id,bl_allocation_id)
);

CREATE OR REPLACE FUNCTION public.guard_delivery_promise_history() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,public AS $$ BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Delivery promise history cannot be deleted'; END IF;
  IF TG_TABLE_NAME='delivery_promise_roots' AND (to_jsonb(NEW)-'version')=(to_jsonb(OLD)-'version') AND NEW.version=OLD.version+1 THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME='delivery_promise_parts' AND OLD.retired_at IS NULL AND NEW.retired_at IS NOT NULL
    AND (to_jsonb(NEW)-'retired_at')=(to_jsonb(OLD)-'retired_at') THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Delivery promise evidence is immutable';
END $$;
DO $$ DECLARE tab text; BEGIN
  FOREACH tab IN ARRAY ARRAY['delivery_promise_roots','delivery_promise_events','delivery_promise_parts','delivery_promise_shipments'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS guard_delivery_promise_history ON public.%I',tab);
    EXECUTE format('CREATE TRIGGER guard_delivery_promise_history BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.guard_delivery_promise_history()',tab);
  END LOOP;
END $$;

-- Match only unique current lines to the FIRST sent AR's customer-facing snapshot.
-- Ambiguous/missing historical evidence remains explicitly untracked, never reconstructed from today's date.
CREATE OR REPLACE FUNCTION public.capture_initial_delivery_promises(order_id bigint) RETURNS void LANGUAGE plpgsql
SET search_path=pg_catalog,public AS $$ BEGIN
  WITH first_ar AS (
    SELECT id,content_snapshot FROM public.commande_ar_log WHERE commande_id=order_id AND status='SENT'
      AND sent_at IS NOT NULL ORDER BY sent_at,id LIMIT 1
  ), matched AS (
    SELECT cl.id AS line_id,ar.id AS ar_id,s.value AS snapshot,count(*) OVER(PARTITION BY cl.id) AS matches
    FROM first_ar ar CROSS JOIN LATERAL jsonb_array_elements(COALESCE(ar.content_snapshot->'lines','[]'::jsonb)) s(value)
    JOIN public.commande_ligne cl ON cl.commande_id=order_id
      AND COALESCE(cl.designation,'')=COALESCE(s.value->>'designation','')
      AND COALESCE(cl.code_piece,'')=COALESCE(s.value->>'code_piece','')
      AND cl.quantite::numeric=CASE WHEN s.value->>'quantite' ~ '^[0-9]+([.][0-9]+)?$' THEN (s.value->>'quantite')::numeric END
    WHERE s.value->>'delai_client' ~ '^\d{4}-\d{2}-\d{2}'
      AND NOT EXISTS(SELECT 1 FROM public.commande_ligne duplicate WHERE duplicate.commande_id=order_id AND duplicate.id<>cl.id
        AND COALESCE(duplicate.designation,'')=COALESCE(cl.designation,'') AND COALESCE(duplicate.code_piece,'')=COALESCE(cl.code_piece,'') AND duplicate.quantite=cl.quantite)
  ), inserted AS (
    INSERT INTO public.delivery_promise_roots(allocation_id,commande_id,line_id,affaire_id,ar_id,initial_quantity,initial_due_date,initial_snapshot)
    SELECT a.id,order_id,m.line_id,a.livraison_affaire_id,m.ar_id,a.qty_ordered,(left(m.snapshot->>'delai_client',10))::date,m.snapshot
    FROM matched m JOIN public.commande_ligne_affaire_allocation a ON a.commande_ligne_id=m.line_id
    WHERE m.matches=1 AND a.qty_ordered>0
      AND (SELECT sum(a2.qty_ordered) FROM public.commande_ligne_affaire_allocation a2 WHERE a2.commande_ligne_id=m.line_id)=(m.snapshot->>'quantite')::numeric
    ON CONFLICT(allocation_id) DO NOTHING RETURNING id,initial_quantity,initial_due_date
  ) INSERT INTO public.delivery_promise_parts(root_id,quantity,due_date) SELECT id,initial_quantity,initial_due_date FROM inserted;
END $$;
DO $$ DECLARE oid bigint; BEGIN
  FOR oid IN SELECT DISTINCT commande_id FROM public.commande_ar_log WHERE status='SENT' LOOP
    PERFORM public.capture_initial_delivery_promises(oid);
  END LOOP;
END $$;

-- Explicit workshop calendar: no invented opening times and no calendar-hour fallback.
-- Existing shipments predate all promise revisions, so their due date is the proven initial AR.
INSERT INTO public.delivery_promise_shipments(part_id,bl_allocation_id,quantity,due_date_at_shipment)
SELECT p.id,a.id,a.quantite,r.initial_due_date FROM public.delivery_promise_roots r
JOIN public.delivery_promise_parts p ON p.root_id=r.id AND p.revision_event_id IS NULL
JOIN public.bon_livraison_ligne_allocations a ON a.commande_ligne_affaire_allocation_id=r.allocation_id
JOIN public.bon_livraison_ligne l ON l.id=a.bon_livraison_ligne_id
JOIN public.bon_livraison bl ON bl.id=l.bon_livraison_id
WHERE bl.statut IN('SHIPPED','DELIVERED') AND a.quantite>0
ON CONFLICT(part_id,bl_allocation_id) DO NOTHING;
CREATE OR REPLACE FUNCTION public.workshop_working_deadline(started timestamptz,hours numeric) RETURNS timestamptz
LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
  WITH cal AS (SELECT c.* FROM public.planning_central_settings s JOIN public.programmation_calendars c ON c.id=s.workshop_calendar_id
    WHERE s.singleton AND c.active AND c.day_start<c.day_end AND hours>0 AND hours<=10000),
  days AS (SELECT cal.*,((started AT TIME ZONE cal.timezone)::date+n)::date AS day FROM cal CROSS JOIN generate_series(0,366) n),
  shifts AS (SELECT greatest((day+day_start) AT TIME ZONE timezone,started) AS starts,(day+day_end) AT TIME ZONE timezone AS ends
    FROM days WHERE extract(isodow FROM day)::smallint=ANY(working_days)
      AND NOT EXISTS(SELECT 1 FROM public.programmation_calendar_closures cl WHERE cl.calendar_id=days.id AND day BETWEEN cl.start_date AND cl.end_date)),
  available AS (SELECT starts,ends,extract(epoch FROM ends-starts) AS seconds FROM shifts WHERE ends>starts),
  totals AS (SELECT *,COALESCE(sum(seconds) OVER(ORDER BY starts ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0) AS preceding FROM available)
  SELECT starts+(hours*3600-preceding)*interval '1 second' FROM totals WHERE preceding<hours*3600 AND preceding+seconds>=hours*3600 ORDER BY starts LIMIT 1
$$;
CREATE OR REPLACE FUNCTION public.workshop_delay_days(initial_date date,actual_date date) RETURNS integer
LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
  WITH cal AS (SELECT c.* FROM public.planning_central_settings s JOIN public.programmation_calendars c ON c.id=s.workshop_calendar_id WHERE s.singleton AND c.active),
  days AS (SELECT cal.*,initial_date+n AS day FROM cal CROSS JOIN generate_series(1,least(greatest(actual_date-initial_date,0),3660)) n)
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM cal) THEN NULL ELSE count(*)::integer END FROM days
  WHERE extract(isodow FROM day)::smallint=ANY(working_days)
    AND NOT EXISTS(SELECT 1 FROM public.programmation_calendar_closures cl WHERE cl.calendar_id=days.id AND day BETWEEN cl.start_date AND cl.end_date)
$$;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='cerp_app') THEN
  GRANT SELECT,INSERT,UPDATE ON public.delivery_promise_roots,public.delivery_promise_parts TO cerp_app;
  GRANT SELECT,INSERT ON public.delivery_promise_events,public.delivery_promise_shipments TO cerp_app;
END IF; END $$;
COMMIT;
