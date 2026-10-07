-- No schedule, qualification or old execution is populated retroactively.
ALTER TABLE public.production_machine_maintenance_plans
 ADD COLUMN counter_value numeric(14,3) CHECK(counter_value IS NULL OR counter_value>=0),
 ADD COLUMN next_due_counter numeric(14,3) CHECK(next_due_counter IS NULL OR next_due_counter>=0);
CREATE TABLE public.production_maintenance_authorizations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),plan_id uuid NOT NULL REFERENCES public.production_machine_maintenance_plans(id) ON DELETE RESTRICT,
 user_id integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,revision integer NOT NULL CHECK(revision>0),enabled boolean NOT NULL,
 valid_from date NOT NULL,valid_to date NOT NULL CHECK(valid_to>=valid_from),reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 3 AND 500),
 document_id uuid NOT NULL REFERENCES public.production_machine_documents(id) ON DELETE RESTRICT,evidence_snapshot jsonb NOT NULL,
 created_by integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(plan_id,user_id,revision)
);
CREATE TABLE public.production_maintenance_receipts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),event_id uuid NOT NULL UNIQUE REFERENCES public.production_machine_maintenance_events(id) ON DELETE RESTRICT,
 machine_id uuid NOT NULL REFERENCES public.machines(id) ON DELETE RESTRICT,plan_id uuid NOT NULL REFERENCES public.production_machine_maintenance_plans(id) ON DELETE RESTRICT,
 authorization_id uuid NOT NULL REFERENCES public.production_maintenance_authorizations(id) ON DELETE RESTRICT,
 document_id uuid NOT NULL REFERENCES public.production_machine_documents(id) ON DELETE RESTRICT,
 plan_snapshot jsonb NOT NULL,evidence_snapshot jsonb NOT NULL,results jsonb NOT NULL,signature_snapshot jsonb NOT NULL,
 counter_value numeric(14,3),next_due_at date,next_due_counter numeric(14,3),notes text NOT NULL,
 created_by integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.production_maintenance_holds (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),machine_id uuid NOT NULL REFERENCES public.machines(id) ON DELETE RESTRICT,
 receipt_id uuid NOT NULL REFERENCES public.production_maintenance_receipts(id) ON DELETE RESTRICT,
 reason text NOT NULL,created_by integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,created_at timestamptz NOT NULL DEFAULT now(),
 resolved_at timestamptz,resolved_by integer REFERENCES public.users(id) ON DELETE RESTRICT,resolution_reason text,
 resolution_document_id uuid REFERENCES public.production_machine_documents(id) ON DELETE RESTRICT,resolution_evidence jsonb,
 CHECK((resolved_at IS NULL AND resolved_by IS NULL AND resolution_reason IS NULL AND resolution_document_id IS NULL AND resolution_evidence IS NULL)
 OR (resolved_at IS NOT NULL AND resolved_by IS NOT NULL AND length(btrim(resolution_reason))>=3 AND resolution_document_id IS NOT NULL AND resolution_evidence IS NOT NULL))
);
CREATE INDEX production_maintenance_holds_active_867 ON public.production_maintenance_holds(machine_id) WHERE resolved_at IS NULL;
CREATE TABLE public.production_maintenance_counter_readings (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),machine_id uuid NOT NULL REFERENCES public.machines(id) ON DELETE RESTRICT,
 plan_id uuid NOT NULL REFERENCES public.production_machine_maintenance_plans(id) ON DELETE RESTRICT,value numeric(14,3) NOT NULL CHECK(value>=0),
 reset boolean NOT NULL DEFAULT false,reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 3 AND 500),
 created_by integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.production_maintenance_commands (
 idempotency_key uuid PRIMARY KEY,actor_id integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
 request_hash text NOT NULL CHECK(request_hash~'^[0-9a-f]{64}$'),result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX production_maintenance_receipts_machine_867 ON public.production_maintenance_receipts(machine_id,created_at DESC);
CREATE INDEX production_maintenance_readings_machine_867 ON public.production_maintenance_counter_readings(machine_id,created_at DESC);
CREATE TRIGGER production_maintenance_authorizations_immutable_867 BEFORE UPDATE OR DELETE ON public.production_maintenance_authorizations FOR EACH ROW EXECUTE FUNCTION public.prevent_material_debit_rewrite();
CREATE TRIGGER production_maintenance_receipts_immutable_867 BEFORE UPDATE OR DELETE ON public.production_maintenance_receipts FOR EACH ROW EXECUTE FUNCTION public.prevent_material_debit_rewrite();
CREATE TRIGGER production_maintenance_counter_readings_immutable_867 BEFORE UPDATE OR DELETE ON public.production_maintenance_counter_readings FOR EACH ROW EXECUTE FUNCTION public.prevent_material_debit_rewrite();
CREATE TRIGGER production_maintenance_commands_immutable_867 BEFORE UPDATE OR DELETE ON public.production_maintenance_commands FOR EACH ROW EXECUTE FUNCTION public.prevent_material_debit_rewrite();
CREATE FUNCTION public.guard_maintenance_hold_rewrite_867() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' OR OLD.resolved_at IS NOT NULL OR NEW.machine_id IS DISTINCT FROM OLD.machine_id OR NEW.receipt_id IS DISTINCT FROM OLD.receipt_id OR NEW.reason IS DISTINCT FROM OLD.reason OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at
 THEN RAISE EXCEPTION 'MAINTENANCE_HOLD_SEALED' USING ERRCODE='23514'; END IF;RETURN NEW;END $$;
CREATE TRIGGER production_maintenance_holds_guard_867 BEFORE UPDATE OR DELETE ON public.production_maintenance_holds FOR EACH ROW EXECUTE FUNCTION public.guard_maintenance_hold_rewrite_867();
CREATE FUNCTION public.guard_maintenance_evidence_rewrite_867() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF EXISTS(SELECT 1 FROM public.production_maintenance_authorizations WHERE document_id=OLD.id)
 OR EXISTS(SELECT 1 FROM public.production_maintenance_receipts WHERE document_id=OLD.id)
 OR EXISTS(SELECT 1 FROM public.production_maintenance_holds WHERE resolution_document_id=OLD.id)
 THEN RAISE EXCEPTION 'MAINTENANCE_EVIDENCE_RETAINED' USING ERRCODE='23514';END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END $$;
CREATE TRIGGER production_maintenance_evidence_guard_867 BEFORE UPDATE OR DELETE ON public.production_machine_documents FOR EACH ROW EXECUTE FUNCTION public.guard_maintenance_evidence_rewrite_867();
CREATE FUNCTION public.guard_maintenance_event_rewrite_867() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF EXISTS(SELECT 1 FROM public.production_maintenance_receipts WHERE event_id=OLD.id)
 THEN RAISE EXCEPTION 'MAINTENANCE_RECEIPT_SEALED' USING ERRCODE='23514';END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;END $$;
CREATE TRIGGER production_maintenance_event_guard_867 BEFORE UPDATE OR DELETE ON public.production_machine_maintenance_events FOR EACH ROW EXECUTE FUNCTION public.guard_maintenance_event_rewrite_867();
GRANT SELECT,INSERT ON public.production_maintenance_authorizations,public.production_maintenance_receipts,public.production_maintenance_holds,public.production_maintenance_counter_readings,public.production_maintenance_commands TO cerp_app;
REVOKE UPDATE,DELETE,TRUNCATE ON public.production_maintenance_authorizations,public.production_maintenance_receipts,public.production_maintenance_holds,public.production_maintenance_counter_readings,public.production_maintenance_commands FROM cerp_app;
GRANT UPDATE(resolved_at,resolved_by,resolution_reason,resolution_document_id,resolution_evidence) ON public.production_maintenance_holds TO cerp_app;
