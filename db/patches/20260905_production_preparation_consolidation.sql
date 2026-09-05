-- #712. Additive preparation evidence and independent demand consolidation.
BEGIN;

INSERT INTO public.app_feature_flags (key, name, description, enabled, environment)
VALUES ('PRODUCTION_WORKBENCH', 'Préparation intégrée des OF', 'Dossier vérifiable et liste de travail Production.', false, 'all'),
       ('PRODUCTION_CONSOLIDATION', 'OF de regroupement', 'Producteur unique et affectations traçables.', false, 'all')
ON CONFLICT (key) DO NOTHING;

ALTER TABLE public.ordres_fabrication
  ADD COLUMN IF NOT EXISTS planning_wait_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS preparation_rules_version integer;
UPDATE public.ordres_fabrication SET planning_wait_started_at = created_at WHERE planning_wait_started_at IS NULL;
ALTER TABLE public.ordres_fabrication ALTER COLUMN planning_wait_started_at SET DEFAULT now();
CREATE INDEX IF NOT EXISTS of_preparation_wait_idx ON public.ordres_fabrication(planning_wait_started_at, id)
  WHERE statut IN ('BROUILLON','PLANIFIE');

ALTER TABLE public.pieces_techniques_achats
  ADD COLUMN IF NOT EXISTS piece_technique_version_id uuid REFERENCES public.piece_technique_versions(id);
CREATE INDEX IF NOT EXISTS pt_achats_version_idx ON public.pieces_techniques_achats(piece_technique_version_id);
-- Historical unassigned purchases remain explicitly unassigned. No guessed index backfill.

CREATE TABLE IF NOT EXISTS public.piece_version_preparation (
  piece_technique_version_id uuid PRIMARY KEY REFERENCES public.piece_technique_versions(id),
  decisions jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(decisions)='object'),
  version integer NOT NULL DEFAULT 1 CHECK (version>0),
  approved_source_hash text,
  approved_at timestamptz,
  approved_by integer REFERENCES public.users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by integer NOT NULL REFERENCES public.users(id)
);
CREATE TABLE IF NOT EXISTS public.of_preparation_evaluations (
  of_id bigint PRIMARY KEY REFERENCES public.ordres_fabrication(id),
  piece_technique_version_id uuid REFERENCES public.piece_technique_versions(id),
  rules_version integer NOT NULL,
  source_hash text NOT NULL,
  items jsonb NOT NULL CHECK(jsonb_typeof(items)='array'),
  ready boolean NOT NULL,
  evaluated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.of_stock_reviews (
  of_id bigint PRIMARY KEY REFERENCES public.ordres_fabrication(id),
  source_hash text NOT NULL,
  decision text NOT NULL CHECK(decision IN ('NO_REUSE','RESERVED','REWORK')),
  reason text NOT NULL CHECK(length(trim(reason))>=3),
  reviewed_at timestamptz NOT NULL DEFAULT now(),
  reviewed_by integer NOT NULL REFERENCES public.users(id)
);
CREATE TABLE IF NOT EXISTS public.of_self_inspection_sheets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  of_id bigint NOT NULL REFERENCES public.ordres_fabrication(id),
  piece_technique_version_id uuid NOT NULL REFERENCES public.piece_technique_versions(id),
  quality_plan_id uuid NOT NULL REFERENCES public.quality_control_plan(id),
  source_hash text NOT NULL,
  snapshot jsonb NOT NULL,
  state text NOT NULL CHECK(state IN ('PENDING','READY','FAILED')),
  pdf bytea,
  pdf_sha256 text,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by integer NOT NULL REFERENCES public.users(id),
  UNIQUE(of_id,source_hash),
  CHECK ((state='READY') = (pdf IS NOT NULL AND pdf_sha256 IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS public.production_consolidations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  producer_of_id bigint NOT NULL UNIQUE REFERENCES public.ordres_fabrication(id),
  idempotency_key uuid NOT NULL UNIQUE,
  request_hash text NOT NULL,
  state text NOT NULL DEFAULT 'ACTIVE' CHECK(state IN ('ACTIVE','DISSOLVED')),
  surplus_quantity numeric(18,3) NOT NULL DEFAULT 0 CHECK(surplus_quantity>=0),
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by integer NOT NULL REFERENCES public.users(id),
  dissolved_at timestamptz,
  dissolved_by integer REFERENCES public.users(id),
  dissolution_reason text
);
CREATE TABLE IF NOT EXISTS public.production_consolidation_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consolidation_id uuid NOT NULL REFERENCES public.production_consolidations(id),
  source_of_id bigint NOT NULL REFERENCES public.ordres_fabrication(id),
  quantity numeric(18,3) NOT NULL CHECK(quantity>0),
  received_quantity numeric(18,3) NOT NULL DEFAULT 0 CHECK(received_quantity>=0 AND received_quantity<=quantity),
  due_date date,
  source_updated_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'ACTIVE' CHECK(state IN ('ACTIVE','CANCELLED')),
  UNIQUE(consolidation_id,source_of_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS production_one_active_coverage_idx
  ON public.production_consolidation_allocations(source_of_id) WHERE state='ACTIVE';
CREATE INDEX IF NOT EXISTS production_allocation_group_idx
  ON public.production_consolidation_allocations(consolidation_id,due_date,source_of_id) WHERE state='ACTIVE';
CREATE TABLE IF NOT EXISTS public.production_consolidation_receipt_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  allocation_id uuid NOT NULL REFERENCES public.production_consolidation_allocations(id),
  movement_id uuid NOT NULL REFERENCES public.stock_movements(id),
  lot_id uuid NOT NULL REFERENCES public.lots(id),
  quantity numeric(18,3) NOT NULL CHECK(quantity>0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(allocation_id,movement_id)
);

CREATE OR REPLACE FUNCTION public.fn_guard_version_purchase_712() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v public.piece_technique_versions; target uuid;
BEGIN
  target := CASE WHEN TG_OP='DELETE' THEN OLD.piece_technique_version_id ELSE NEW.piece_technique_version_id END;
  IF TG_OP='UPDATE' AND OLD.piece_technique_version_id IS NOT NULL AND OLD.piece_technique_version_id IS DISTINCT FROM NEW.piece_technique_version_id THEN
    RAISE EXCEPTION 'PURCHASE_VERSION_IMMUTABLE: copier la ligne dans la nouvelle révision' USING ERRCODE='23514';
  END IF;
  IF target IS NOT NULL THEN
    SELECT * INTO v FROM public.piece_technique_versions WHERE id=target FOR UPDATE;
    IF v.id IS NULL OR v.piece_technique_id IS DISTINCT FROM (CASE WHEN TG_OP='DELETE' THEN OLD.piece_technique_id ELSE NEW.piece_technique_id END) THEN
      RAISE EXCEPTION 'PURCHASE_VERSION_SCOPE: révision étrangère à la pièce' USING ERRCODE='23514';
    END IF;
    IF v.statut NOT IN ('BROUILLON','EN_VALIDATION') THEN
      RAISE EXCEPTION 'PURCHASE_VERSION_LOCKED: créer une révision pour modifier les achats' USING ERRCODE='23514';
    END IF;
    UPDATE public.piece_version_preparation SET approved_source_hash=NULL,approved_at=NULL,approved_by=NULL,version=version+1,updated_at=now() WHERE piece_technique_version_id=target;
    UPDATE public.ordres_fabrication SET technical_readiness='INCOMPLETE',technical_submitted_at=NULL,technical_submitted_by=NULL,updated_at=now()
      WHERE piece_technique_id=v.piece_technique_id AND statut='BROUILLON' AND technical_snapshot_sha256 IS NULL
      AND COALESCE(NULLIF(technical_preparation->>'selected_version_id','')::uuid,NULLIF(technical_preparation->>'selected_draft_version_id','')::uuid)=target;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS guard_version_purchase_712 ON public.pieces_techniques_achats;
CREATE TRIGGER guard_version_purchase_712 BEFORE INSERT OR UPDATE OR DELETE ON public.pieces_techniques_achats FOR EACH ROW EXECUTE FUNCTION public.fn_guard_version_purchase_712();

CREATE OR REPLACE FUNCTION public.fn_assert_of_not_covered_712(target bigint) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF target IS NULL THEN RETURN; END IF;
  PERFORM id FROM public.ordres_fabrication WHERE id=target FOR UPDATE;
  IF EXISTS(SELECT 1 FROM public.production_consolidation_allocations WHERE source_of_id=target AND state='ACTIVE') THEN
    RAISE EXCEPTION 'OF_COVERED_BY_CONSOLIDATION: utiliser l''OF producteur' USING ERRCODE='23514';
  END IF;
END $$;
CREATE OR REPLACE FUNCTION public.fn_guard_covered_execution_712() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target bigint;
BEGIN
  IF TG_TABLE_NAME='ordres_fabrication' THEN
    IF NEW.statut IS NOT DISTINCT FROM OLD.statut AND NEW.quantite_lancee IS NOT DISTINCT FROM OLD.quantite_lancee
      AND NEW.quantite_bonne IS NOT DISTINCT FROM OLD.quantite_bonne AND NEW.quantite_rebut IS NOT DISTINCT FROM OLD.quantite_rebut THEN RETURN NEW; END IF;
    target:=NEW.id;
  ELSIF TG_TABLE_NAME='of_time_logs' THEN
    SELECT of_id INTO target FROM public.of_operations WHERE id=NEW.of_operation_id;
  ELSIF TG_TABLE_NAME='planning_events' THEN
    target:=NEW.of_id;
    IF NEW.of_operation_id IS NOT NULL THEN
      PERFORM public.fn_assert_of_not_covered_712((SELECT of_id FROM public.of_operations WHERE id=NEW.of_operation_id));
    END IF;
  ELSE target:=NEW.of_id;
  END IF;
  PERFORM public.fn_assert_of_not_covered_712(target);
  RETURN NEW;
END $$;
DO $$ DECLARE tab text; BEGIN
  FOREACH tab IN ARRAY ARRAY['of_operations','of_time_logs','production_pointages','production_quantity_declarations','planning_events','of_output_lots','of_receipts'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS guard_covered_execution_712 ON public.%I',tab);
    EXECUTE format('CREATE TRIGGER guard_covered_execution_712 BEFORE INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.fn_guard_covered_execution_712()',tab);
  END LOOP;
END $$;
DROP TRIGGER IF EXISTS guard_covered_execution_712 ON public.ordres_fabrication;
CREATE TRIGGER guard_covered_execution_712 BEFORE UPDATE ON public.ordres_fabrication FOR EACH ROW EXECUTE FUNCTION public.fn_guard_covered_execution_712();

CREATE OR REPLACE FUNCTION public.fn_check_consolidation_quantity_712() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid; expected numeric; allocated numeric; actual numeric; producer bigint;
BEGIN
  target:=CASE WHEN TG_TABLE_NAME='production_consolidations' THEN NEW.id ELSE NEW.consolidation_id END;
  SELECT c.surplus_quantity,o.quantite_lancee,c.producer_of_id INTO expected,actual,producer
    FROM public.production_consolidations c JOIN public.ordres_fabrication o ON o.id=c.producer_of_id WHERE c.id=target AND c.state='ACTIVE';
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT COALESCE(sum(quantity),0) INTO allocated FROM public.production_consolidation_allocations WHERE consolidation_id=target AND state='ACTIVE';
  IF actual<>expected+allocated OR EXISTS(SELECT 1 FROM public.production_consolidation_allocations WHERE consolidation_id=target AND source_of_id=producer) THEN
    RAISE EXCEPTION 'CONSOLIDATION_QUANTITY_MISMATCH: quantités non conservées' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS check_consolidation_quantity_712 ON public.production_consolidations;
CREATE CONSTRAINT TRIGGER check_consolidation_quantity_712 AFTER INSERT OR UPDATE ON public.production_consolidations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.fn_check_consolidation_quantity_712();
DROP TRIGGER IF EXISTS check_consolidation_quantity_712 ON public.production_consolidation_allocations;
CREATE CONSTRAINT TRIGGER check_consolidation_quantity_712 AFTER INSERT OR UPDATE ON public.production_consolidation_allocations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.fn_check_consolidation_quantity_712();

COMMIT;
