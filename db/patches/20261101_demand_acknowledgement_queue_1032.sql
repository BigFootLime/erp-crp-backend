BEGIN;
ALTER TABLE public.industrial_policies ADD COLUMN auto_ar_contact_id uuid REFERENCES public.contacts(contact_id);
CREATE TABLE public.demand_acknowledgement_jobs(
 revision_id uuid PRIMARY KEY REFERENCES public.demand_pilot_revisions(id),
 commande_id bigint NOT NULL REFERENCES public.commande_client(id),
 actor_id integer NOT NULL REFERENCES public.users(id),
 status text NOT NULL DEFAULT 'PENDING' CHECK(status IN('PENDING','PROCESSING','READY','SENT','UNCHANGED','RETRY','REVIEW')),
 idempotency_key uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),attempts int NOT NULL DEFAULT 0,
 ar_id uuid REFERENCES public.commande_ar_log(id),next_attempt timestamptz NOT NULL DEFAULT now(),
 reason text,updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX demand_ack_jobs_schedule ON public.demand_acknowledgement_jobs(status,next_attempt);
CREATE FUNCTION public.queue_demand_acknowledgement_1032() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW.kind='FIRM' AND NEW.status='MATERIALIZED' AND OLD.status IS DISTINCT FROM NEW.status THEN
   INSERT INTO public.demand_acknowledgement_jobs(revision_id,commande_id,actor_id)
    SELECT NEW.id,root.commande_id,j.requested_by_user_id FROM public.demand_pilot_firm_bindings b
    JOIN public.demand_pilot_revisions bound ON bound.id=b.revision_id
    JOIN public.delivery_promise_roots root ON root.id=b.promise_root_id
    JOIN public.demand_pilot_materialization_jobs j ON j.revision_id=NEW.id
    WHERE (bound.client_id,bound.external_site,bound.external_order_key,bound.external_line_key,bound.external_schedule_key,bound.article_id)
    =(NEW.client_id,NEW.external_site,NEW.external_order_key,NEW.external_line_key,NEW.external_schedule_key,NEW.article_id)
    AND root.commande_id IS NOT NULL AND j.requested_by_user_id IS NOT NULL
    ORDER BY bound.revision_no DESC LIMIT 1 ON CONFLICT(revision_id) DO NOTHING;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER demand_ack_after_materialization AFTER UPDATE OF status ON public.demand_pilot_revisions
 FOR EACH ROW EXECUTE FUNCTION public.queue_demand_acknowledgement_1032();
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='cerp_app') THEN
 GRANT SELECT,INSERT,UPDATE ON public.demand_acknowledgement_jobs TO cerp_app;
END IF; END $$;
COMMIT;
