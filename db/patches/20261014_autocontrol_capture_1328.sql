-- Paper is an alternative capture medium, never an automatic release decision.
CREATE TABLE IF NOT EXISTS public.quality_autocontrol_capture (
  control_id uuid PRIMARY KEY REFERENCES public.quality_control(id),
  document_id uuid NOT NULL REFERENCES public.quality_documents(id),
  document_sha256 text NOT NULL CHECK (document_sha256 ~ '^[a-f0-9]{64}$'),
  conforming_qty numeric NOT NULL CHECK (conforming_qty >= 0),
  instrument_snapshots jsonb NOT NULL CHECK (jsonb_typeof(instrument_snapshots)='array'),
  captured_by integer NOT NULL REFERENCES public.users(id),
  captured_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS quality_autocontrol_capture_document_idx ON public.quality_autocontrol_capture(document_id);

CREATE OR REPLACE FUNCTION public.fn_guard_autocontrol_capture_1328() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE c public.quality_control%ROWTYPE; d public.quality_documents%ROWTYPE;
BEGIN
  SELECT * INTO c FROM public.quality_control WHERE id=COALESCE(NEW.control_id,OLD.control_id) FOR UPDATE;
  IF c.validation_date IS NOT NULL OR c.status::text='CANCELLED' THEN
    RAISE EXCEPTION 'AUTOCONTROL_EXECUTION_CLOSED' USING ERRCODE='23514';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  IF c.source_type IS DISTINCT FROM 'OF_OPERATION' OR c.of_id IS NULL OR c.operation_id IS NULL
    OR c.source_id IS DISTINCT FROM c.operation_id::text OR c.trigger_type IS NULL OR c.trigger_type NOT IN ('FIRST_ARTICLE','IN_PROCESS','FINAL') THEN
    RAISE EXCEPTION 'AUTOCONTROL_OPERATION_REQUIRED' USING ERRCODE='23514';
  END IF;
  SELECT * INTO d FROM public.quality_documents WHERE id=NEW.document_id FOR UPDATE;
  IF d.id IS NULL OR d.entity_type::text IS DISTINCT FROM 'CONTROL' OR d.entity_id IS DISTINCT FROM c.id OR d.removed_at IS NOT NULL
    OR d.sha256 IS DISTINCT FROM NEW.document_sha256 OR d.size_bytes<=0
    OR d.mime_type NOT IN ('application/pdf','image/jpeg','image/png')
    OR NEW.conforming_qty>c.qty_population THEN
    RAISE EXCEPTION 'AUTOCONTROL_SCAN_SCOPE_OR_QUANTITY' USING ERRCODE='23514';
  END IF;
  IF EXISTS(SELECT 1 FROM public.quality_control_points WHERE quality_control_id=c.id) THEN
    RAISE EXCEPTION 'AUTOCONTROL_CAPTURE_MIXED' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_guard_autocontrol_capture_1328 ON public.quality_autocontrol_capture;
CREATE TRIGGER trg_guard_autocontrol_capture_1328 BEFORE INSERT OR UPDATE OR DELETE ON public.quality_autocontrol_capture
  FOR EACH ROW EXECUTE FUNCTION public.fn_guard_autocontrol_capture_1328();

CREATE OR REPLACE FUNCTION public.fn_protect_autocontrol_scan_1328() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM public.quality_autocontrol_capture WHERE document_id=OLD.id)
    AND (TG_OP='DELETE' OR NEW IS DISTINCT FROM OLD) THEN
    RAISE EXCEPTION 'AUTOCONTROL_SCAN_IN_USE' USING ERRCODE='23514';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_protect_autocontrol_scan_1328 ON public.quality_documents;
CREATE TRIGGER trg_protect_autocontrol_scan_1328 BEFORE UPDATE OR DELETE ON public.quality_documents
  FOR EACH ROW EXECUTE FUNCTION public.fn_protect_autocontrol_scan_1328();
REVOKE ALL ON public.quality_autocontrol_capture FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.quality_autocontrol_capture TO cerp_app;
REVOKE ALL ON FUNCTION public.fn_guard_autocontrol_capture_1328(),public.fn_protect_autocontrol_scan_1328() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_guard_autocontrol_capture_1328(),public.fn_protect_autocontrol_scan_1328() TO cerp_app;

CREATE OR REPLACE FUNCTION public.fn_guard_autocontrol_measurement_1328() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM public.quality_control WHERE id=NEW.quality_control_id FOR UPDATE;
  IF EXISTS(SELECT 1 FROM public.quality_autocontrol_capture WHERE control_id=NEW.quality_control_id) THEN
    RAISE EXCEPTION 'AUTOCONTROL_CAPTURE_MIXED' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_guard_autocontrol_measurement_1328 ON public.quality_control_points;
CREATE TRIGGER trg_guard_autocontrol_measurement_1328 BEFORE INSERT OR UPDATE ON public.quality_control_points
  FOR EACH ROW EXECUTE FUNCTION public.fn_guard_autocontrol_measurement_1328();
REVOKE ALL ON FUNCTION public.fn_guard_autocontrol_measurement_1328() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_guard_autocontrol_measurement_1328() TO cerp_app;

CREATE OR REPLACE FUNCTION public.fn_guard_autocontrol_scope_1328() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE capture public.quality_autocontrol_capture%ROWTYPE;
BEGIN
  SELECT * INTO capture FROM public.quality_autocontrol_capture WHERE control_id=OLD.id;
  IF capture.control_id IS NOT NULL AND (
    (NEW.of_id,NEW.operation_id,NEW.source_type,NEW.source_id,NEW.trigger_type,NEW.plan_snapshot_sha256,NEW.qty_population)
      IS DISTINCT FROM (OLD.of_id,OLD.operation_id,OLD.source_type,OLD.source_id,OLD.trigger_type,OLD.plan_snapshot_sha256,OLD.qty_population)
    OR NEW.qty_controlled IS DISTINCT FROM NEW.qty_population OR NEW.qty_conforming IS DISTINCT FROM capture.conforming_qty) THEN
    RAISE EXCEPTION 'AUTOCONTROL_SCOPE_OR_LEDGER_CHANGED' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_guard_autocontrol_scope_1328 ON public.quality_control;
CREATE TRIGGER trg_guard_autocontrol_scope_1328 BEFORE UPDATE ON public.quality_control
  FOR EACH ROW EXECUTE FUNCTION public.fn_guard_autocontrol_scope_1328();
REVOKE ALL ON FUNCTION public.fn_guard_autocontrol_scope_1328() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_guard_autocontrol_scope_1328() TO cerp_app;
