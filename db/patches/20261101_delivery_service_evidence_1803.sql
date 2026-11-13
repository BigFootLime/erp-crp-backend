-- Explicit, append-only evidence for the two distinct delivery commitments.
-- Existing AR due dates remain customer-arrival evidence; no departure date is inferred.
BEGIN;

ALTER TABLE public.delivery_promise_shipments
  ADD COLUMN IF NOT EXISTS departure_due_date_at_shipment date NULL;

CREATE TABLE IF NOT EXISTS public.delivery_promise_site_evidence (
  root_id uuid PRIMARY KEY REFERENCES public.delivery_promise_roots(id) ON DELETE RESTRICT,
  delivery_address_id uuid NOT NULL REFERENCES public.adresse_livraison(delivery_address_id) ON DELETE RESTRICT,
  actor_id integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  request_key text NOT NULL,
  request jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(actor_id, request_key)
);

CREATE TABLE IF NOT EXISTS public.delivery_promise_departure_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  root_id uuid NOT NULL REFERENCES public.delivery_promise_roots(id) ON DELETE RESTRICT,
  part_id uuid NOT NULL REFERENCES public.delivery_promise_parts(id) ON DELETE RESTRICT,
  root_version bigint NOT NULL,
  due_date date NOT NULL,
  actor_id integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  request_key text NOT NULL,
  request jsonb NOT NULL,
  reason text NOT NULL CHECK(char_length(btrim(reason)) >= 5),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(actor_id, request_key),
  UNIQUE(root_id, part_id, root_version)
);
CREATE INDEX IF NOT EXISTS delivery_promise_departure_events_part_idx ON public.delivery_promise_departure_events(part_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.client_portal_delivery_receipt_allocations (
  receipt_id uuid NOT NULL REFERENCES public.client_portal_delivery_receipts(id) ON DELETE RESTRICT,
  bon_livraison_ligne_allocation_id uuid NOT NULL REFERENCES public.bon_livraison_ligne_allocations(id) ON DELETE RESTRICT,
  quantity_received numeric(18,3) NOT NULL CHECK(quantity_received>0),
  PRIMARY KEY(receipt_id,bon_livraison_ligne_allocation_id)
);
DROP TRIGGER IF EXISTS guard_client_portal_delivery_receipt_allocations_1803 ON public.client_portal_delivery_receipt_allocations;
CREATE TRIGGER guard_client_portal_delivery_receipt_allocations_1803 BEFORE UPDATE OR DELETE ON public.client_portal_delivery_receipt_allocations FOR EACH ROW EXECUTE FUNCTION public.fn_client_portal_delivery_evidence_immutable_1802();

CREATE OR REPLACE FUNCTION public.guard_delivery_promise_service_evidence_1803() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,public AS $$ BEGIN
  RAISE EXCEPTION 'delivery promise service evidence is immutable' USING ERRCODE='55000';
END $$;
DROP TRIGGER IF EXISTS guard_delivery_promise_site_evidence_1803 ON public.delivery_promise_site_evidence;
CREATE TRIGGER guard_delivery_promise_site_evidence_1803 BEFORE UPDATE OR DELETE ON public.delivery_promise_site_evidence FOR EACH ROW EXECUTE FUNCTION public.guard_delivery_promise_service_evidence_1803();
DROP TRIGGER IF EXISTS guard_delivery_promise_departure_events_1803 ON public.delivery_promise_departure_events;
CREATE TRIGGER guard_delivery_promise_departure_events_1803 BEFORE UPDATE OR DELETE ON public.delivery_promise_departure_events FOR EACH ROW EXECUTE FUNCTION public.guard_delivery_promise_service_evidence_1803();

-- Historic roots remain unscoped: their author is not available as evidence.
-- An authorised CRP user must record the site explicitly before those open
-- promises can be shown in a portal's site-scoped overdue queue.

DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='cerp_app') THEN
  GRANT SELECT,INSERT ON public.delivery_promise_site_evidence,public.delivery_promise_departure_events,public.client_portal_delivery_receipt_allocations TO cerp_app;
  GRANT SELECT,UPDATE(departure_due_date_at_shipment) ON public.delivery_promise_shipments TO cerp_app;
END IF; END $$;
COMMIT;
