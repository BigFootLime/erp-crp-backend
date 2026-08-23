-- #626. DB backstops deliberately mirror the HTTP guards: no direct SQL may
-- create an unlinked work package or lose custody of material.
BEGIN;
DO $$ BEGIN IF to_regclass('public.commande_fournisseur_ligne') IS NULL OR to_regclass('public.commande_fournisseur') IS NULL OR to_regclass('public.of_operations') IS NULL OR to_regclass('public.pieces_techniques_operations') IS NULL OR to_regclass('public.ged_documents') IS NULL OR to_regclass('public.lots') IS NULL THEN RAISE EXCEPTION 'SUBCONTRACT_626_PREREQUISITE_MISSING'; END IF; END $$;
CREATE TABLE IF NOT EXISTS public.subcontract_work_packages (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), supplier_order_line_id uuid NOT NULL REFERENCES public.commande_fournisseur_ligne(id) ON DELETE RESTRICT, of_operation_id uuid NOT NULL REFERENCES public.of_operations(id) ON DELETE RESTRICT, status text NOT NULL DEFAULT 'SENT' CHECK(status IN('SENT','CLOSED','CANCELLED')), unit text NOT NULL CHECK(length(btrim(unit)) BETWEEN 1 AND 32), qty_planned numeric(14,3) NOT NULL CHECK(qty_planned>0), row_version integer NOT NULL DEFAULT 1 CHECK(row_version>0), ged_evidence_document_id uuid NOT NULL REFERENCES public.ged_documents(id) ON DELETE RESTRICT, created_at timestamptz NOT NULL DEFAULT now(), created_by integer, closed_at timestamptz, closed_by integer, close_reason text, UNIQUE(supplier_order_line_id), UNIQUE(of_operation_id), CHECK((status='SENT' AND closed_at IS NULL AND close_reason IS NULL) OR (status IN('CLOSED','CANCELLED') AND closed_at IS NOT NULL AND length(btrim(close_reason))>0)));
CREATE TABLE IF NOT EXISTS public.subcontract_work_package_ledger (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), package_id uuid NOT NULL REFERENCES public.subcontract_work_packages(id) ON DELETE RESTRICT, event_type text NOT NULL CHECK(event_type IN('ISSUE','RETURN')), lot_id uuid NOT NULL REFERENCES public.lots(id) ON DELETE RESTRICT, qty numeric(14,3) NOT NULL CHECK(qty>0), unit text NOT NULL CHECK(length(btrim(unit)) BETWEEN 1 AND 32), idempotency_key text NOT NULL CHECK(length(btrim(idempotency_key)) BETWEEN 8 AND 128), created_at timestamptz NOT NULL DEFAULT now(), created_by integer, UNIQUE(idempotency_key));
CREATE INDEX IF NOT EXISTS subcontract_work_packages_open_of_idx ON public.subcontract_work_packages(of_operation_id) WHERE status='SENT';
CREATE INDEX IF NOT EXISTS subcontract_work_package_ledger_package_idx ON public.subcontract_work_package_ledger(package_id,created_at);
CREATE OR REPLACE FUNCTION public.fn_subcontract_package_contract_626() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' AND NOT EXISTS(SELECT 1 FROM public.commande_fournisseur_ligne l JOIN public.commande_fournisseur c ON c.id=l.commande_id JOIN public.of_operations o ON o.id=NEW.of_operation_id AND o.of_id=l.of_id JOIN public.pieces_techniques_operations source ON source.id=o.source_piece_operation_id AND source.type_operation='SOUS_TRAITANCE' WHERE l.id=NEW.supplier_order_line_id AND l.type='SOUS_TRAITANCE' AND l.statut_ligne='ACTIVE' AND c.statut IN('ENVOYEE','ACCUSE_RECU','PARTIELLEMENT_RECUE')) THEN RAISE EXCEPTION 'SUBCONTRACT_PACKAGE_CANONICAL_LINK_INVALID' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' AND NOT EXISTS(SELECT 1 FROM public.ged_documents WHERE id=NEW.ged_evidence_document_id AND archived_at IS NULL) THEN RAISE EXCEPTION 'SUBCONTRACT_PACKAGE_GED_EVIDENCE_INVALID' USING ERRCODE='23503'; END IF;
 IF TG_OP='UPDATE' AND (NEW.supplier_order_line_id IS DISTINCT FROM OLD.supplier_order_line_id OR NEW.of_operation_id IS DISTINCT FROM OLD.of_operation_id OR NEW.unit IS DISTINCT FROM OLD.unit OR NEW.qty_planned IS DISTINCT FROM OLD.qty_planned OR NEW.ged_evidence_document_id IS DISTINCT FROM OLD.ged_evidence_document_id) THEN RAISE EXCEPTION 'SUBCONTRACT_PACKAGE_IMMUTABLE' USING ERRCODE='55000'; END IF;
 IF TG_OP='UPDATE' AND NEW.status IN('CLOSED','CANCELLED') AND OLD.status='SENT' AND EXISTS(SELECT 1 FROM public.subcontract_work_package_ledger e WHERE e.package_id=OLD.id GROUP BY e.package_id HAVING COALESCE(sum(e.qty) FILTER (WHERE e.event_type='ISSUE'),0)<>COALESCE(sum(e.qty) FILTER (WHERE e.event_type='RETURN'),0)) THEN RAISE EXCEPTION 'SUBCONTRACT_CUSTODY_OPEN' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' AND OLD.status IN('CLOSED','CANCELLED') THEN RAISE EXCEPTION 'SUBCONTRACT_PACKAGE_FINAL' USING ERRCODE='55000'; END IF; RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_subcontract_package_contract_626 ON public.subcontract_work_packages;
CREATE TRIGGER trg_subcontract_package_contract_626 BEFORE INSERT OR UPDATE ON public.subcontract_work_packages FOR EACH ROW EXECUTE FUNCTION public.fn_subcontract_package_contract_626();
CREATE OR REPLACE FUNCTION public.fn_subcontract_ledger_contract_626() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE package_unit text; package_status text; issued numeric; returned numeric;
BEGIN
 SELECT unit,status INTO package_unit,package_status FROM public.subcontract_work_packages WHERE id=NEW.package_id FOR UPDATE;
 IF NOT FOUND OR package_status<>'SENT' THEN RAISE EXCEPTION 'SUBCONTRACT_PACKAGE_NOT_OPEN' USING ERRCODE='23514'; END IF;
 IF upper(btrim(NEW.unit))<>upper(btrim(package_unit)) THEN RAISE EXCEPTION 'SUBCONTRACT_UNIT_MISMATCH' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.lots WHERE id=NEW.lot_id AND lot_status=CASE WHEN NEW.event_type='ISSUE' THEN 'LIBERE' ELSE 'QUARANTAINE' END) THEN RAISE EXCEPTION 'SUBCONTRACT_LOT_QUALITY_GATE' USING ERRCODE='23514'; END IF;
 IF NEW.event_type='RETURN' THEN SELECT COALESCE(sum(qty) FILTER (WHERE event_type='ISSUE'),0),COALESCE(sum(qty) FILTER (WHERE event_type='RETURN'),0) INTO issued,returned FROM public.subcontract_work_package_ledger WHERE package_id=NEW.package_id; IF returned+NEW.qty>issued THEN RAISE EXCEPTION 'SUBCONTRACT_OVER_RETURN' USING ERRCODE='23514'; END IF; END IF; RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_subcontract_ledger_contract_626 ON public.subcontract_work_package_ledger;
CREATE TRIGGER trg_subcontract_ledger_contract_626 BEFORE INSERT ON public.subcontract_work_package_ledger FOR EACH ROW EXECUTE FUNCTION public.fn_subcontract_ledger_contract_626();
CREATE OR REPLACE FUNCTION public.fn_subcontract_ledger_immutable_626() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'SUBCONTRACT_LEDGER_IMMUTABLE' USING ERRCODE='55000'; END $$;
DROP TRIGGER IF EXISTS trg_subcontract_ledger_immutable_626 ON public.subcontract_work_package_ledger;
CREATE TRIGGER trg_subcontract_ledger_immutable_626 BEFORE UPDATE OR DELETE ON public.subcontract_work_package_ledger FOR EACH ROW EXECUTE FUNCTION public.fn_subcontract_ledger_immutable_626();
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='cerp_app') THEN GRANT SELECT,INSERT,UPDATE ON public.subcontract_work_packages,public.subcontract_work_package_ledger TO cerp_app; END IF; END $$;
COMMIT;
