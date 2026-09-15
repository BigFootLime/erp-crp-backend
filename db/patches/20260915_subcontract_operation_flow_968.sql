-- #717 / frontend #967 #968: link physical returns and released WIP to their evidence.
-- Existing custody entries are immutable and are not inferred/backfilled.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';
DO $$ BEGIN
  IF to_regclass('public.subcontract_work_package_ledger') IS NULL
    OR to_regclass('public.production_transfer_batches') IS NULL
    OR to_regclass('public.reception_subcontract_origins') IS NULL THEN
    RAISE EXCEPTION 'SUBCONTRACT_FLOW_PREREQUISITES_MISSING';
  END IF;
END $$;
ALTER TABLE public.production_transfer_batches
  ADD COLUMN IF NOT EXISTS subcontract_origin_id uuid REFERENCES public.reception_subcontract_origins(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS transfer_subcontract_origin_idx ON public.production_transfer_batches(subcontract_origin_id) WHERE subcontract_origin_id IS NOT NULL;
CREATE OR REPLACE FUNCTION public.subcontract_receipt_transferred_968(receipt uuid) RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT COALESCE(sum(b.released_quantity),0) FROM public.production_transfer_batches b
    JOIN public.reception_subcontract_origins o ON o.id=b.subcontract_origin_id WHERE o.receipt_line_id=receipt
$$;
CREATE TABLE IF NOT EXISTS public.subcontract_supplier_calendars (
  supplier_id uuid PRIMARY KEY REFERENCES public.fournisseurs(id) ON DELETE RESTRICT,
  calendar_id uuid NOT NULL REFERENCES public.programmation_calendars(id) ON DELETE RESTRICT
);
INSERT INTO public.erp_settings(key,value_text,definition,unit,period_start,source,freshness_at,reliability)
VALUES('subcontract.flow_enabled','true','Autoriser les nouveaux transferts de retours de sous-traitance','BOOLEAN',CURRENT_DATE,'Migration #968',now(),'DECLARED')
ON CONFLICT(key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.guard_subcontract_flow_968() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p public.subcontract_work_packages; r public.reception_subcontract_origins; used numeric; source_of bigint; target_of bigint; receipt_qty numeric; stocked numeric;
BEGIN
  IF TG_TABLE_NAME='subcontract_work_package_ledger' THEN
    SELECT * INTO p FROM public.subcontract_work_packages WHERE id=NEW.package_id FOR UPDATE;
    IF NEW.event_type='ISSUE' THEN
      SELECT COALESCE(sum(qty),0) INTO used FROM public.subcontract_work_package_ledger WHERE package_id=p.id AND event_type='ISSUE';
      IF used+NEW.qty>p.qty_planned THEN RAISE EXCEPTION 'SUBCONTRACT_OVER_ISSUE' USING ERRCODE='23514'; END IF;
    END IF;
  ELSE
    IF TG_OP='UPDATE' AND OLD.subcontract_origin_id IS NOT NULL AND
      (NEW.subcontract_origin_id IS DISTINCT FROM OLD.subcontract_origin_id OR NEW.operation_id IS DISTINCT FROM OLD.operation_id OR NEW.successor_operation_id IS DISTINCT FROM OLD.successor_operation_id OR NEW.quantity IS DISTINCT FROM OLD.quantity) THEN
      RAISE EXCEPTION 'SUBCONTRACT_TRANSFER_SOURCE_IMMUTABLE' USING ERRCODE='55000';
    END IF;
    IF NEW.subcontract_origin_id IS NULL THEN RETURN NEW; END IF;
    IF NEW.material_debit_id IS NOT NULL THEN RAISE EXCEPTION 'SUBCONTRACT_TRANSFER_TWO_SOURCES' USING ERRCODE='23514'; END IF;
    SELECT * INTO r FROM public.reception_subcontract_origins WHERE id=NEW.subcontract_origin_id FOR UPDATE;
    SELECT * INTO p FROM public.subcontract_work_packages WHERE id=r.package_id;
    IF r.id IS NULL OR p.of_operation_id<>NEW.operation_id THEN
      RAISE EXCEPTION 'SUBCONTRACT_TRANSFER_SOURCE_INVALID' USING ERRCODE='23514';
    END IF;
    SELECT of_id INTO source_of FROM public.of_operations WHERE id=NEW.operation_id;
    SELECT of_id INTO target_of FROM public.of_operations WHERE id=NEW.successor_operation_id;
    IF source_of IS DISTINCT FROM target_of THEN RAISE EXCEPTION 'SUBCONTRACT_TRANSFER_OF_MISMATCH' USING ERRCODE='23514'; END IF;
    SELECT COALESCE(sum(released_quantity),0) INTO used FROM public.production_transfer_batches
      WHERE subcontract_origin_id=r.id AND id<>NEW.id;
    IF used+NEW.released_quantity>r.quantity THEN RAISE EXCEPTION 'SUBCONTRACT_TRANSFER_OVERALLOCATED' USING ERRCODE='23514'; END IF;
    SELECT qty_received INTO receipt_qty FROM public.reception_fournisseur_lignes WHERE id=r.receipt_line_id FOR UPDATE;
    SELECT COALESCE(sum(s.qty),0) INTO stocked FROM public.reception_fournisseur_stock_receipts s
      JOIN public.stock_movements m ON m.id=s.stock_movement_id WHERE s.reception_line_id=r.receipt_line_id AND m.status='POSTED';
    SELECT COALESCE(sum(b.released_quantity),0) INTO used FROM public.production_transfer_batches b
      JOIN public.reception_subcontract_origins origin ON origin.id=b.subcontract_origin_id WHERE origin.receipt_line_id=r.receipt_line_id AND b.id<>NEW.id;
    IF used+stocked+NEW.released_quantity>receipt_qty THEN RAISE EXCEPTION 'SUBCONTRACT_RECEIPT_OVERALLOCATED' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION public.guard_subcontract_stock_968() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE total numeric; received numeric;
BEGIN
  SELECT qty_received INTO received FROM public.reception_fournisseur_lignes WHERE id=NEW.reception_line_id FOR UPDATE;
  SELECT COALESCE(sum(s.qty),0) INTO total FROM public.reception_fournisseur_stock_receipts s
    JOIN public.stock_movements m ON m.id=s.stock_movement_id WHERE s.reception_line_id=NEW.reception_line_id AND s.id<>NEW.id AND m.status='POSTED';
  IF public.subcontract_receipt_transferred_968(NEW.reception_line_id)+total+NEW.qty>received THEN
    RAISE EXCEPTION 'SUBCONTRACT_RECEIPT_OVERALLOCATED' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='subcontract_stock_968' AND tgrelid='public.reception_fournisseur_stock_receipts'::regclass) THEN
    CREATE TRIGGER subcontract_stock_968 BEFORE INSERT ON public.reception_fournisseur_stock_receipts FOR EACH ROW EXECUTE FUNCTION public.guard_subcontract_stock_968();
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='subcontract_flow_968' AND tgrelid='public.subcontract_work_package_ledger'::regclass) THEN
    CREATE TRIGGER subcontract_flow_968 BEFORE INSERT ON public.subcontract_work_package_ledger FOR EACH ROW EXECUTE FUNCTION public.guard_subcontract_flow_968();
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='subcontract_flow_968' AND tgrelid='public.production_transfer_batches'::regclass) THEN
    CREATE TRIGGER subcontract_flow_968 BEFORE INSERT OR UPDATE ON public.production_transfer_batches FOR EACH ROW EXECUTE FUNCTION public.guard_subcontract_flow_968();
  END IF;
END $$;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['subcontract_work_packages','subcontract_work_package_ledger','reception_subcontract_origins','subcontract_supplier_calendars'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='planning_invalidate' AND tgrelid=('public.'||t)::regclass) THEN
      EXECUTE format('CREATE TRIGGER planning_invalidate AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.planning_invalidate()',t);
    END IF;
  END LOOP;
END $$;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='cerp_app') THEN
  ALTER TABLE public.subcontract_supplier_calendars OWNER TO cerp_app;
  GRANT SELECT,INSERT,UPDATE ON public.subcontract_supplier_calendars TO cerp_app;
END IF; END $$;
COMMIT;
