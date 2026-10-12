-- Return a whole unshipped urgency withdrawal. Retain OFs, charge and all original evidence.
BEGIN;
SET LOCAL lock_timeout='5s';
CREATE TABLE public.delivery_urgency_restitutions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL UNIQUE REFERENCES public.delivery_urgency_requests(id) ON DELETE RESTRICT,
  withdrawal_id uuid NOT NULL UNIQUE REFERENCES public.delivery_urgency_withdrawals(id) ON DELETE RESTRICT,
  request_version integer NOT NULL CHECK(request_version>0),
  charge_id uuid NOT NULL REFERENCES public.delivery_urgency_order_charges(id) ON DELETE RESTRICT,
  fee_decision text NOT NULL CHECK(fee_decision='KEEP'),
  reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 10 AND 1000),
  evidence jsonb NOT NULL CHECK(jsonb_typeof(evidence)='object'),
  response jsonb NOT NULL CHECK(jsonb_typeof(response)='object'),
  preview_hash text NOT NULL CHECK(preview_hash ~ '^[0-9a-f]{64}$'),
  request_key uuid NOT NULL,
  request_hash text NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'),
  created_by integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id,request_id), UNIQUE(created_by,request_key)
);
ALTER TABLE public.delivery_urgency_requests ADD CONSTRAINT delivery_urgency_restitution_owner
  FOREIGN KEY(restitution_id,id) REFERENCES public.delivery_urgency_restitutions(id,request_id) ON DELETE RESTRICT;
CREATE OR REPLACE FUNCTION public.fn_delivery_urgency_request_identity_1033() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR (NEW.id,NEW.beneficiary_allocation_id,NEW.quantity,NEW.reason,NEW.preview_hash,NEW.snapshot,
    NEW.request_key,NEW.request_hash,NEW.created_by,NEW.created_at) IS DISTINCT FROM
    (OLD.id,OLD.beneficiary_allocation_id,OLD.quantity,OLD.reason,OLD.preview_hash,OLD.snapshot,
    OLD.request_key,OLD.request_hash,OLD.created_by,OLD.created_at) OR NEW.version<>OLD.version+1 THEN
    RAISE EXCEPTION 'Retain urgency identity, version and evidence' USING ERRCODE='55000';
  END IF;
  IF OLD.status IN ('WAITING_PLANNER','APPROVED') AND NEW.status='CANCELLED'
    AND NEW.approved_id IS NOT DISTINCT FROM OLD.approved_id AND NEW.withdrawn_id IS NULL AND NEW.restitution_id IS NULL
    AND NEW.cancellation_evidence->'request'->>'id'=OLD.id::text
    AND NEW.cancellation_evidence->'request'->>'version'=OLD.version::text
    AND NEW.cancellation_evidence->'request'->>'status'=OLD.status
    AND jsonb_typeof(NEW.cancellation_evidence->'tree')='array'
    AND (OLD.status<>'APPROVED' OR NEW.cancellation_retains_production) THEN RETURN NEW; END IF;
  IF OLD.status='WITHDRAWN' AND NEW.status='CANCELLED' AND NEW.restitution_id IS NOT NULL
    AND NEW.approved_id=OLD.approved_id AND NEW.withdrawn_id=OLD.withdrawn_id AND NEW.cancellation_retains_production
    AND NEW.cancellation_evidence->'request'->>'id'=OLD.id::text
    AND NEW.cancellation_evidence->'request'->>'version'=OLD.version::text
    AND EXISTS(SELECT 1 FROM public.delivery_urgency_restitutions restitution WHERE restitution.id=NEW.restitution_id
      AND restitution.request_id=OLD.id AND restitution.request_version=OLD.version AND restitution.withdrawal_id=OLD.withdrawn_id
      AND restitution.created_by=NEW.cancelled_by AND restitution.reason=NEW.cancellation_reason) THEN RETURN NEW; END IF;
  IF OLD.status='APPROVED' AND NEW.status='WITHDRAWN' AND NEW.approved_id=OLD.approved_id AND NEW.restitution_id IS NULL
    AND EXISTS(SELECT 1 FROM public.delivery_urgency_withdrawals withdrawal WHERE withdrawal.id=NEW.withdrawn_id
      AND withdrawal.request_id=OLD.id AND withdrawal.request_version=OLD.version AND withdrawal.approval_id=OLD.approved_id) THEN RETURN NEW; END IF;
  IF OLD.status IN ('WAITING_PLANNER','APPROVED') AND NEW.status='APPROVED' AND NEW.restitution_id IS NULL
    AND EXISTS(SELECT 1 FROM public.delivery_urgency_approvals approval WHERE approval.id=NEW.approved_id
      AND approval.request_id=OLD.id AND approval.request_version=OLD.version) THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Explicit approval, cancellation or complete restitution required' USING ERRCODE='55000';
END $$;
CREATE TABLE public.delivery_urgency_restitution_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restitution_id uuid NOT NULL REFERENCES public.delivery_urgency_restitutions(id) ON DELETE RESTRICT,
  transfer_id uuid NOT NULL UNIQUE REFERENCES public.delivery_urgency_transfers(id) ON DELETE RESTRICT,
  donor_reservation_id uuid REFERENCES public.stock_reservations(id) ON DELETE RESTRICT,
  donor_quantity numeric(18,3) NOT NULL CHECK(donor_quantity>=0),
  free_quantity numeric(18,3) NOT NULL CHECK(free_quantity>=0),
  free_movement_id uuid UNIQUE REFERENCES public.stock_movements(id) ON DELETE RESTRICT,
  reservation_evidence jsonb NOT NULL CHECK(jsonb_typeof(reservation_evidence)='object'),
  CHECK(donor_quantity+free_quantity>0),
  CHECK((donor_quantity>0)=(donor_reservation_id IS NOT NULL)),
  CHECK((free_quantity>0)=(free_movement_id IS NOT NULL))
);
CREATE INDEX urgency_restitution_lines_parent_idx ON public.delivery_urgency_restitution_lines(restitution_id);
CREATE TRIGGER urgency_restitution_immutable BEFORE UPDATE OR DELETE ON public.delivery_urgency_restitutions
  FOR EACH ROW EXECUTE FUNCTION public.fn_protect_stock_immutable_evidence();
CREATE TRIGGER urgency_restitution_lines_immutable BEFORE UPDATE OR DELETE ON public.delivery_urgency_restitution_lines
  FOR EACH ROW EXECUTE FUNCTION public.fn_protect_stock_immutable_evidence();
CREATE FUNCTION public.fn_urgency_restitution_identity_1033() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE request record;
BEGIN
  SELECT r.*,a.commande_id INTO request FROM public.delivery_urgency_requests r
    JOIN public.commande_ligne_affaire_allocation a ON a.id=r.beneficiary_allocation_id WHERE r.id=NEW.request_id FOR UPDATE OF r;
  IF request.status IS DISTINCT FROM 'WITHDRAWN' OR request.version IS DISTINCT FROM NEW.request_version
    OR request.withdrawn_id IS DISTINCT FROM NEW.withdrawal_id OR NOT EXISTS(
      SELECT 1 FROM public.delivery_urgency_order_charges charge WHERE charge.id=NEW.charge_id AND charge.commande_id=request.commande_id) THEN
    RAISE EXCEPTION 'Restitution requires the current withdrawal and preserves its order charge' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER urgency_restitution_identity BEFORE INSERT ON public.delivery_urgency_restitutions
  FOR EACH ROW EXECUTE FUNCTION public.fn_urgency_restitution_identity_1033();
CREATE FUNCTION public.fn_urgency_restitution_line_identity_1033() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE origin record; target record; source record; before_row jsonb; after_row jsonb; original_qty numeric; remaining_qty numeric;
  replenished numeric; returned_to_donor numeric;
BEGIN
  SELECT t.*,s.recovery_id,r.donor_allocation_id,r.quantity AS recovery_quantity,restore.id AS restoration_id INTO origin
    FROM public.delivery_urgency_transfers t JOIN public.delivery_urgency_sources s ON s.id=t.source_id
    JOIN public.delivery_urgency_recoveries r ON r.id=s.recovery_id
    JOIN public.delivery_urgency_restitutions restore ON restore.withdrawal_id=t.withdrawal_id
    WHERE t.id=NEW.transfer_id AND restore.id=NEW.restitution_id FOR UPDATE OF r;
  IF origin.restoration_id IS NULL OR origin.quantity IS DISTINCT FROM NEW.donor_quantity+NEW.free_quantity THEN
    RAISE EXCEPTION 'Restitution must reconcile the exact original transfer' USING ERRCODE='23514';
  END IF;
  SELECT * INTO source FROM public.stock_reservations WHERE id=origin.beneficiary_reservation_id;
  before_row:=NEW.reservation_evidence->'before'; after_row:=NEW.reservation_evidence->'after';
  original_qty:=(before_row->>'qty_reserved')::numeric;
  remaining_qty:=CASE WHEN source.status='RELEASED' THEN 0 ELSE source.qty_reserved END;
  IF before_row IS NULL OR after_row IS NULL OR before_row->>'id' IS DISTINCT FROM source.id::text
    OR after_row IS DISTINCT FROM to_jsonb(source) OR before_row->>'status' IS DISTINCT FROM 'ACTIVE'
    OR (before_row->>'qty_prepared')::numeric IS DISTINCT FROM 0 OR (before_row->>'qty_consumed')::numeric IS DISTINCT FROM 0
    OR source.qty_prepared<>0 OR source.qty_consumed<>0
    OR original_qty-remaining_qty IS DISTINCT FROM origin.quantity
    OR source.version IS DISTINCT FROM (before_row->>'version')::integer+1 THEN
    RAISE EXCEPTION 'Restitution requires an exact release of unprepared, unshipped stock' USING ERRCODE='23514';
  END IF;
  IF NEW.donor_quantity>0 THEN
    SELECT * INTO target FROM public.stock_reservations WHERE id=NEW.donor_reservation_id;
    SELECT COALESCE(sum(quantity),0) INTO replenished FROM public.delivery_urgency_replenishments WHERE recovery_id=origin.recovery_id;
    SELECT COALESCE(sum(line.donor_quantity),0) INTO returned_to_donor FROM public.delivery_urgency_restitution_lines line
      JOIN public.delivery_urgency_transfers transfer ON transfer.id=line.transfer_id
      JOIN public.delivery_urgency_sources s ON s.id=transfer.source_id WHERE s.recovery_id=origin.recovery_id;
    IF target.status IS DISTINCT FROM 'ACTIVE' OR target.commande_ligne_affaire_allocation_id IS DISTINCT FROM origin.donor_allocation_id
      OR (target.article_id,target.lot_id,target.stock_level_id,target.stock_batch_id,target.location_id)
        IS DISTINCT FROM (source.article_id,source.lot_id,source.stock_level_id,source.stock_batch_id,source.location_id)
      OR NEW.donor_quantity>target.qty_reserved-target.qty_consumed
      OR replenished+returned_to_donor+NEW.donor_quantity>origin.recovery_quantity THEN
      RAISE EXCEPTION 'Returned stock must restore its own donor without duplicating replacements' USING ERRCODE='23514';
    END IF;
  END IF;
  IF NEW.free_quantity>0 AND NOT EXISTS(SELECT 1 FROM public.stock_movements movement
    JOIN public.stock_movement_lines line ON line.movement_id=movement.id
    JOIN public.emplacements src ON src.id=line.src_emplacement_id
    JOIN public.emplacements dst ON dst.id=line.dst_emplacement_id
    JOIN public.stock_lane_locations lane ON lane.location_id=dst.location_id AND lane.lane='FREE'
    WHERE movement.id=NEW.free_movement_id AND movement.status='POSTED' AND movement.movement_type='TRANSFER'
      AND movement.source_document_type='URGENCY_RESTITUTION' AND movement.source_document_id=NEW.restitution_id::text
      AND line.article_id=source.article_id AND line.lot_id=source.lot_id AND src.location_id=source.location_id
      AND line.qty=NEW.free_quantity AND (SELECT count(*) FROM public.stock_movement_lines WHERE movement_id=movement.id)=1) THEN
    RAISE EXCEPTION 'Surplus restitution needs its posted physical transfer to free stock' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER urgency_restitution_line_identity BEFORE INSERT ON public.delivery_urgency_restitution_lines
  FOR EACH ROW EXECUTE FUNCTION public.fn_urgency_restitution_line_identity_1033();
CREATE FUNCTION public.fn_urgency_restitution_balance_1033() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE restoration uuid; request record; restored numeric;
BEGIN
  IF TG_TABLE_NAME='delivery_urgency_restitutions' THEN restoration:=NEW.id; ELSE restoration:=NEW.restitution_id; END IF;
  SELECT r.*,s.withdrawal_id,s.request_version INTO request FROM public.delivery_urgency_restitutions s
    JOIN public.delivery_urgency_requests r ON r.id=s.request_id WHERE s.id=restoration;
  SELECT COALESCE(sum(donor_quantity+free_quantity),0) INTO restored FROM public.delivery_urgency_restitution_lines WHERE restitution_id=restoration;
  IF request.status IS DISTINCT FROM 'CANCELLED' OR request.restitution_id IS DISTINCT FROM restoration
    OR request.withdrawn_id IS DISTINCT FROM request.withdrawal_id OR request.version<>request.request_version+1
    OR NOT request.cancellation_retains_production OR restored IS DISTINCT FROM request.quantity THEN
    RAISE EXCEPTION 'Restitution, exact stock return and cancellation must commit together' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER urgency_restitution_balance AFTER INSERT ON public.delivery_urgency_restitutions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.fn_urgency_restitution_balance_1033();
CREATE CONSTRAINT TRIGGER urgency_restitution_lines_balance AFTER INSERT ON public.delivery_urgency_restitution_lines
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.fn_urgency_restitution_balance_1033();
REVOKE ALL ON public.delivery_urgency_restitutions,public.delivery_urgency_restitution_lines FROM PUBLIC,cerp_app;
GRANT SELECT,INSERT ON public.delivery_urgency_restitutions,public.delivery_urgency_restitution_lines TO cerp_app;
REVOKE ALL ON FUNCTION public.fn_urgency_restitution_identity_1033(),public.fn_urgency_restitution_line_identity_1033(),public.fn_urgency_restitution_balance_1033() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_urgency_restitution_identity_1033(),public.fn_urgency_restitution_line_identity_1033(),public.fn_urgency_restitution_balance_1033() TO cerp_app;
COMMIT;
