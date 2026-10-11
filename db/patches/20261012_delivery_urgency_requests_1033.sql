-- #1033: durable, reversible urgency preparation. No withdrawal authorization.
BEGIN;
SET LOCAL lock_timeout='5s';
CREATE TABLE public.delivery_urgency_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  beneficiary_allocation_id bigint NOT NULL REFERENCES public.commande_ligne_affaire_allocation(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'WAITING_PLANNER' CHECK(status IN ('WAITING_PLANNER','APPROVED','CANCELLED')),
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  quantity numeric(18,3) NOT NULL CHECK(quantity>0 AND quantity<1000000000),
  reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 10 AND 1000),
  preview_hash text NOT NULL CHECK(preview_hash ~ '^[0-9a-f]{64}$'),
  snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object'),
  request_key uuid NOT NULL,
  request_hash text NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'),
  created_by integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  cancelled_by integer REFERENCES public.users(id) ON DELETE RESTRICT,
  cancelled_at timestamptz,
  cancellation_reason text,
  approved_id uuid,
  UNIQUE(created_by,request_key),
  CHECK((status IN ('WAITING_PLANNER','APPROVED') AND cancelled_by IS NULL AND cancelled_at IS NULL AND cancellation_reason IS NULL)
    OR (status='CANCELLED' AND cancelled_by IS NOT NULL AND cancelled_at IS NOT NULL
      AND length(btrim(cancellation_reason)) BETWEEN 10 AND 1000)),
  CHECK((status='APPROVED')=(approved_id IS NOT NULL))
);
CREATE UNIQUE INDEX delivery_urgency_active_beneficiary_idx
  ON public.delivery_urgency_requests(beneficiary_allocation_id) WHERE status IN ('WAITING_PLANNER','APPROVED');
CREATE TABLE public.delivery_urgency_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES public.delivery_urgency_requests(id) ON DELETE RESTRICT,
  request_version integer NOT NULL CHECK(request_version>0),
  preview_hash text NOT NULL CHECK(preview_hash ~ '^[0-9a-f]{64}$'),
  planning_revision bigint NOT NULL,
  evidence jsonb NOT NULL CHECK(jsonb_typeof(evidence)='object'),
  response jsonb NOT NULL CHECK(jsonb_typeof(response)='object'),
  request_key uuid NOT NULL,
  request_hash text NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'),
  created_by integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id,request_id), UNIQUE(request_id,request_version), UNIQUE(created_by,request_key)
);
ALTER TABLE public.delivery_urgency_requests ADD CONSTRAINT delivery_urgency_approval_owner
  FOREIGN KEY(approved_id,id) REFERENCES public.delivery_urgency_approvals(id,request_id) ON DELETE RESTRICT;
CREATE TABLE public.delivery_urgency_recoveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES public.delivery_urgency_requests(id) ON DELETE RESTRICT,
  donor_allocation_id bigint NOT NULL REFERENCES public.commande_ligne_affaire_allocation(id) ON DELETE RESTRICT,
  recovery_of_id bigint NOT NULL UNIQUE REFERENCES public.ordres_fabrication(id) ON DELETE RESTRICT,
  quantity numeric(18,3) NOT NULL CHECK(quantity>0 AND quantity<1000000000),
  protected_due_date date NOT NULL,
  initial_ar_due_date date NOT NULL,
  donor_snapshot jsonb NOT NULL CHECK(jsonb_typeof(donor_snapshot)='object'),
  UNIQUE(request_id,donor_allocation_id)
);
CREATE TABLE public.delivery_urgency_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recovery_id uuid NOT NULL REFERENCES public.delivery_urgency_recoveries(id) ON DELETE RESTRICT,
  donor_reservation_id uuid NOT NULL REFERENCES public.stock_reservations(id) ON DELETE RESTRICT,
  quantity numeric(18,3) NOT NULL CHECK(quantity>0 AND quantity<1000000000),
  reservation_snapshot jsonb NOT NULL CHECK(jsonb_typeof(reservation_snapshot)='object'),
  UNIQUE(recovery_id,donor_reservation_id)
);
CREATE INDEX delivery_urgency_sources_reservation_idx ON public.delivery_urgency_sources(donor_reservation_id);
CREATE FUNCTION public.fn_delivery_urgency_request_identity_1033() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR (NEW.id,NEW.beneficiary_allocation_id,NEW.quantity,NEW.reason,NEW.preview_hash,NEW.snapshot,
    NEW.request_key,NEW.request_hash,NEW.created_by,NEW.created_at) IS DISTINCT FROM
    (OLD.id,OLD.beneficiary_allocation_id,OLD.quantity,OLD.reason,OLD.preview_hash,OLD.snapshot,
    OLD.request_key,OLD.request_hash,OLD.created_by,OLD.created_at)
    OR NEW.version<>OLD.version+1 THEN
    RAISE EXCEPTION 'Retain urgency identity, version and evidence' USING ERRCODE='55000';
  END IF;
  IF OLD.status='WAITING_PLANNER' AND NEW.status='CANCELLED' AND NEW.approved_id IS NULL THEN RETURN NEW; END IF;
  IF OLD.status IN ('WAITING_PLANNER','APPROVED') AND NEW.status='APPROVED'
    AND EXISTS(SELECT 1 FROM public.delivery_urgency_approvals approval WHERE approval.id=NEW.approved_id
      AND approval.request_id=OLD.id AND approval.request_version=OLD.version) THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Explicit approval or draft cancellation required' USING ERRCODE='55000';
  RETURN NEW;
END $$;
CREATE TRIGGER delivery_urgency_request_identity BEFORE UPDATE OR DELETE ON public.delivery_urgency_requests
  FOR EACH ROW EXECUTE FUNCTION public.fn_delivery_urgency_request_identity_1033();
CREATE TRIGGER delivery_urgency_recoveries_immutable BEFORE UPDATE OR DELETE ON public.delivery_urgency_recoveries
  FOR EACH ROW EXECUTE FUNCTION public.fn_protect_stock_immutable_evidence();
CREATE TRIGGER delivery_urgency_sources_immutable BEFORE UPDATE OR DELETE ON public.delivery_urgency_sources
  FOR EACH ROW EXECUTE FUNCTION public.fn_protect_stock_immutable_evidence();
CREATE TRIGGER delivery_urgency_approvals_immutable BEFORE UPDATE OR DELETE ON public.delivery_urgency_approvals
  FOR EACH ROW EXECUTE FUNCTION public.fn_protect_stock_immutable_evidence();
CREATE FUNCTION public.fn_delivery_urgency_approval_identity_1033() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE request record;
BEGIN
  SELECT * INTO request FROM public.delivery_urgency_requests WHERE id=NEW.request_id FOR UPDATE;
  IF request.status NOT IN ('WAITING_PLANNER','APPROVED') OR request.version IS DISTINCT FROM NEW.request_version THEN
    RAISE EXCEPTION 'Approval requires the current active request version' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER delivery_urgency_approval_identity BEFORE INSERT ON public.delivery_urgency_approvals
  FOR EACH ROW EXECUTE FUNCTION public.fn_delivery_urgency_approval_identity_1033();
CREATE FUNCTION public.fn_delivery_urgency_recovery_identity_1033() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE beneficiary record; donor record; producer record;
BEGIN
  SELECT allocation.id,command.client_id,line.article_id,request.status INTO beneficiary FROM public.delivery_urgency_requests request
    JOIN public.commande_ligne_affaire_allocation allocation ON allocation.id=request.beneficiary_allocation_id
    JOIN public.commande_client command ON command.id=allocation.commande_id
    JOIN public.commande_ligne line ON line.id=allocation.commande_ligne_id WHERE request.id=NEW.request_id;
  SELECT allocation.*,command.client_id,line.article_id,line.piece_technique_version_id INTO donor
    FROM public.commande_ligne_affaire_allocation allocation
    JOIN public.commande_client command ON command.id=allocation.commande_id
    JOIN public.commande_ligne line ON line.id=allocation.commande_ligne_id WHERE allocation.id=NEW.donor_allocation_id;
  SELECT * INTO producer FROM public.ordres_fabrication WHERE id=NEW.recovery_of_id;
  IF beneficiary.status IS DISTINCT FROM 'WAITING_PLANNER' OR beneficiary.id=NEW.donor_allocation_id
    OR donor.client_id IS DISTINCT FROM beneficiary.client_id
    OR donor.article_id IS DISTINCT FROM beneficiary.article_id
    OR (producer.commande_id,producer.commande_ligne_id,producer.affaire_id,producer.article_id,producer.client_id::text)
      IS DISTINCT FROM (donor.commande_id,donor.commande_ligne_id,donor.livraison_affaire_id,donor.article_id,donor.client_id::text)
    OR producer.statut::text IS DISTINCT FROM 'BROUILLON' OR producer.quantite_lancee IS DISTINCT FROM NEW.quantity
    OR COALESCE(producer.piece_technique_version_id,NULLIF(producer.technical_preparation->>'selected_version_id','')::uuid)
      IS DISTINCT FROM donor.piece_technique_version_id THEN
    RAISE EXCEPTION 'Urgency recovery must restore its own client, donor affair, definition and exact quantity' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER delivery_urgency_recovery_identity BEFORE INSERT ON public.delivery_urgency_recoveries
  FOR EACH ROW EXECUTE FUNCTION public.fn_delivery_urgency_recovery_identity_1033();
CREATE FUNCTION public.fn_delivery_urgency_source_identity_1033() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE donor_allocation bigint; source record; pending numeric;
BEGIN
  SELECT donor_allocation_id INTO donor_allocation FROM public.delivery_urgency_recoveries WHERE id=NEW.recovery_id;
  SELECT reservation.commande_ligne_affaire_allocation_id AS allocation_id,reservation.status,lane.lane,
    reservation.qty_reserved-reservation.qty_consumed-reservation.qty_prepared AS remaining INTO source
    FROM public.stock_reservations reservation JOIN public.stock_lane_locations lane ON lane.location_id=reservation.location_id
    WHERE reservation.id=NEW.donor_reservation_id FOR UPDATE OF reservation;
  SELECT COALESCE(sum(existing.quantity),0) INTO pending FROM public.delivery_urgency_sources existing
    JOIN public.delivery_urgency_recoveries recovery ON recovery.id=existing.recovery_id
    JOIN public.delivery_urgency_requests request ON request.id=recovery.request_id
    WHERE existing.donor_reservation_id=NEW.donor_reservation_id AND request.status IN ('WAITING_PLANNER','APPROVED');
  IF source.allocation_id IS DISTINCT FROM donor_allocation OR source.status IS DISTINCT FROM 'ACTIVE'
    OR source.lane IS DISTINCT FROM 'DELIVERY' OR source.remaining IS NULL OR NEW.quantity+pending>source.remaining THEN
    RAISE EXCEPTION 'Urgency source must belong to the protected donor delivery reservation' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER delivery_urgency_source_identity BEFORE INSERT ON public.delivery_urgency_sources
  FOR EACH ROW EXECUTE FUNCTION public.fn_delivery_urgency_source_identity_1033();
CREATE FUNCTION public.fn_delivery_urgency_quantities_1033() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE request_uuid uuid; expected numeric; actual numeric;
BEGIN
  IF TG_TABLE_NAME='delivery_urgency_requests' THEN request_uuid:=NEW.id;
  ELSIF TG_TABLE_NAME='delivery_urgency_recoveries' THEN request_uuid:=NEW.request_id;
  ELSE SELECT request_id INTO request_uuid FROM public.delivery_urgency_recoveries WHERE id=NEW.recovery_id;
  END IF;
  SELECT quantity INTO expected FROM public.delivery_urgency_requests WHERE id=request_uuid;
  SELECT COALESCE(sum(quantity),0) INTO actual FROM public.delivery_urgency_recoveries WHERE request_id=request_uuid;
  IF expected IS DISTINCT FROM actual OR EXISTS(SELECT 1 FROM public.delivery_urgency_recoveries recovery
    WHERE recovery.request_id=request_uuid AND recovery.quantity IS DISTINCT FROM
      (SELECT COALESCE(sum(source.quantity),0) FROM public.delivery_urgency_sources source WHERE source.recovery_id=recovery.id)) THEN
    RAISE EXCEPTION 'Urgency request, recovery OFs and borrowed quantities must balance exactly' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER delivery_urgency_request_quantities AFTER INSERT ON public.delivery_urgency_requests
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.fn_delivery_urgency_quantities_1033();
CREATE CONSTRAINT TRIGGER delivery_urgency_recovery_quantities AFTER INSERT ON public.delivery_urgency_recoveries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.fn_delivery_urgency_quantities_1033();
CREATE CONSTRAINT TRIGGER delivery_urgency_source_quantities AFTER INSERT ON public.delivery_urgency_sources
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.fn_delivery_urgency_quantities_1033();
REVOKE ALL ON public.delivery_urgency_requests,public.delivery_urgency_recoveries,public.delivery_urgency_sources,public.delivery_urgency_approvals FROM PUBLIC,cerp_app;
GRANT SELECT,INSERT,UPDATE ON public.delivery_urgency_requests TO cerp_app;
GRANT SELECT,INSERT ON public.delivery_urgency_recoveries,public.delivery_urgency_sources,public.delivery_urgency_approvals TO cerp_app;
REVOKE ALL ON FUNCTION public.fn_delivery_urgency_request_identity_1033(),public.fn_delivery_urgency_recovery_identity_1033(),
  public.fn_delivery_urgency_source_identity_1033(),public.fn_delivery_urgency_quantities_1033(),public.fn_delivery_urgency_approval_identity_1033() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_delivery_urgency_request_identity_1033(),public.fn_delivery_urgency_recovery_identity_1033(),
  public.fn_delivery_urgency_source_identity_1033(),public.fn_delivery_urgency_quantities_1033(),public.fn_delivery_urgency_approval_identity_1033() TO cerp_app;
COMMIT;
