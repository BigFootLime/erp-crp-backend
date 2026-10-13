-- Additive cancellation of empty workspaces. No control, sample, snapshot,
-- quantity, stock movement or quality decision is deleted or backfilled.
ALTER TYPE public.quality_control_status ADD VALUE IF NOT EXISTS 'CANCELLED';
ALTER TABLE public.quality_control
  ADD COLUMN IF NOT EXISTS execution_cancelled_at timestamptz,
  ADD COLUMN IF NOT EXISTS execution_cancelled_by integer REFERENCES public.users(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS execution_cancellation_reason text;

ALTER TABLE public.quality_control DROP CONSTRAINT IF EXISTS quality_control_validated_status_chk;
ALTER TABLE public.quality_control ADD CONSTRAINT quality_control_validated_status_chk CHECK (
  (validation_date IS NULL AND validated_by IS NULL AND status::text IN ('PLANNED','IN_PROGRESS','CANCELLED'))
  OR (validation_date IS NOT NULL AND validated_by IS NOT NULL AND status::text IN ('VALIDATED','REJECTED'))
);
ALTER TABLE public.quality_control DROP CONSTRAINT IF EXISTS quality_control_cancellation_1276_ck;
ALTER TABLE public.quality_control ADD CONSTRAINT quality_control_cancellation_1276_ck CHECK (
  (status::text='CANCELLED' AND execution_cancelled_at IS NOT NULL AND execution_cancelled_by IS NOT NULL
    AND execution_cancellation_reason IS NOT NULL AND char_length(btrim(execution_cancellation_reason)) BETWEEN 8 AND 1000
    AND validation_date IS NULL AND validated_by IS NULL)
  OR (status::text<>'CANCELLED' AND execution_cancelled_at IS NULL AND execution_cancelled_by IS NULL
    AND execution_cancellation_reason IS NULL)
);

CREATE OR REPLACE FUNCTION public.fn_protect_empty_quality_cancellation_1276()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status::text='CANCELLED' THEN
    RAISE EXCEPTION 'a cancelled quality workspace remains immutable';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  IF NEW.status::text='CANCELLED' THEN
    IF OLD.status::text NOT IN ('PLANNED','IN_PROGRESS') OR OLD.validation_date IS NOT NULL
      OR EXISTS(SELECT 1 FROM public.quality_control_points WHERE quality_control_id=OLD.id)
      OR EXISTS(SELECT 1 FROM public.quality_measurement_revisions WHERE quality_control_id=OLD.id)
      OR EXISTS(SELECT 1 FROM public.quality_release_decision WHERE quality_control_id=OLD.id)
      OR COALESCE(OLD.qty_controlled,0)<>0 OR COALESCE(OLD.qty_conforming,0)<>0
      OR COALESCE(OLD.qty_released,0)<>0 OR COALESCE(OLD.qty_held,0)<>0
      OR COALESCE(OLD.qty_scrapped,0)<>0 OR COALESCE(OLD.qty_reworked,0)<>0
      OR COALESCE(OLD.qty_sorted,0)<>0 OR COALESCE(OLD.qty_returned,0)<>0
      OR COALESCE(OLD.qty_consumed,0)<>0
    THEN RAISE EXCEPTION 'only an empty undecided quality workspace can be cancelled'; END IF;
    IF (to_jsonb(NEW)-ARRAY['status','execution_cancelled_at','execution_cancelled_by','execution_cancellation_reason','updated_at','updated_by'])
      IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','execution_cancelled_at','execution_cancelled_by','execution_cancellation_reason','updated_at','updated_by'])
    THEN RAISE EXCEPTION 'cancellation preserves the source, plan and quantities'; END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_protect_empty_quality_cancellation_1276 ON public.quality_control;
CREATE TRIGGER trg_protect_empty_quality_cancellation_1276 BEFORE UPDATE OR DELETE ON public.quality_control
  FOR EACH ROW EXECUTE FUNCTION public.fn_protect_empty_quality_cancellation_1276();

-- Serialize samples and decisions with cancellation even for direct writers.
CREATE OR REPLACE FUNCTION public.fn_refuse_cancelled_quality_child_1276()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent record; previous_id uuid; current_id uuid;
BEGIN
  IF TG_OP<>'INSERT' THEN previous_id=(to_jsonb(OLD)->>'quality_control_id')::uuid; END IF;
  IF TG_OP<>'DELETE' THEN current_id=(to_jsonb(NEW)->>'quality_control_id')::uuid; END IF;
  FOR parent IN SELECT id,status::text AS status FROM public.quality_control
    WHERE id=previous_id OR id=current_id ORDER BY id FOR UPDATE
  LOOP
    IF parent.status='CANCELLED' THEN RAISE EXCEPTION 'a cancelled quality workspace accepts no measurements or decisions'; END IF;
  END LOOP;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_refuse_cancelled_quality_point_1276 ON public.quality_control_points;
CREATE TRIGGER trg_refuse_cancelled_quality_point_1276 BEFORE INSERT OR UPDATE OR DELETE ON public.quality_control_points
  FOR EACH ROW EXECUTE FUNCTION public.fn_refuse_cancelled_quality_child_1276();
DROP TRIGGER IF EXISTS trg_refuse_cancelled_quality_decision_1276 ON public.quality_release_decision;
CREATE TRIGGER trg_refuse_cancelled_quality_decision_1276 BEFORE INSERT OR UPDATE OR DELETE ON public.quality_release_decision
  FOR EACH ROW EXECUTE FUNCTION public.fn_refuse_cancelled_quality_child_1276();
