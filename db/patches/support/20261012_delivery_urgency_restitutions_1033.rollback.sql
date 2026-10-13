-- Restore the previous application first. Committed restitution history is never deleted.
BEGIN;
SET LOCAL lock_timeout='5s';
LOCK TABLE public.delivery_urgency_requests,public.delivery_urgency_restitutions,public.delivery_urgency_restitution_lines IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM public.delivery_urgency_restitutions) OR EXISTS(SELECT 1 FROM public.delivery_urgency_requests WHERE restitution_id IS NOT NULL) THEN
  RAISE EXCEPTION 'Retain committed restitution; apply a forward correction';
 END IF;
END $$;
CREATE OR REPLACE FUNCTION public.fn_delivery_urgency_request_identity_1033() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR (NEW.id,NEW.beneficiary_allocation_id,NEW.quantity,NEW.reason,NEW.preview_hash,NEW.snapshot,
    NEW.request_key,NEW.request_hash,NEW.created_by,NEW.created_at) IS DISTINCT FROM
    (OLD.id,OLD.beneficiary_allocation_id,OLD.quantity,OLD.reason,OLD.preview_hash,OLD.snapshot,
    OLD.request_key,OLD.request_hash,OLD.created_by,OLD.created_at)
    OR NEW.version<>OLD.version+1 THEN
    RAISE EXCEPTION 'Retain urgency identity, version and evidence' USING ERRCODE='55000';
  END IF;
  IF OLD.status IN ('WAITING_PLANNER','APPROVED') AND NEW.status='CANCELLED'
    AND NEW.approved_id IS NOT DISTINCT FROM OLD.approved_id AND NEW.withdrawn_id IS NULL AND NEW.restitution_id IS NULL
    AND NEW.cancellation_evidence->'request'->>'id'=OLD.id::text
    AND NEW.cancellation_evidence->'request'->>'version'=OLD.version::text
    AND NEW.cancellation_evidence->'request'->>'status'=OLD.status
    AND jsonb_typeof(NEW.cancellation_evidence->'tree')='array'
    AND (OLD.status<>'APPROVED' OR NEW.cancellation_retains_production) THEN RETURN NEW; END IF;
  IF OLD.status='APPROVED' AND NEW.status='WITHDRAWN' AND NEW.approved_id=OLD.approved_id AND NEW.restitution_id IS NULL
    AND EXISTS(SELECT 1 FROM public.delivery_urgency_withdrawals withdrawal WHERE withdrawal.id=NEW.withdrawn_id
      AND withdrawal.request_id=OLD.id AND withdrawal.request_version=OLD.version AND withdrawal.approval_id=OLD.approved_id)
    THEN RETURN NEW; END IF;
  IF OLD.status IN ('WAITING_PLANNER','APPROVED') AND NEW.status='APPROVED' AND NEW.restitution_id IS NULL
    AND EXISTS(SELECT 1 FROM public.delivery_urgency_approvals approval WHERE approval.id=NEW.approved_id
      AND approval.request_id=OLD.id AND approval.request_version=OLD.version) THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Explicit approval or draft cancellation required' USING ERRCODE='55000';
  RETURN NEW;
END $$;
ALTER TABLE public.delivery_urgency_requests DROP CONSTRAINT delivery_urgency_restitution_owner;
DROP TABLE public.delivery_urgency_restitution_lines;
DROP TABLE public.delivery_urgency_restitutions;
DROP FUNCTION public.fn_urgency_restitution_line_identity_1033();
DROP FUNCTION public.fn_urgency_restitution_identity_1033();
DROP FUNCTION public.fn_urgency_restitution_balance_1033();
COMMIT;
