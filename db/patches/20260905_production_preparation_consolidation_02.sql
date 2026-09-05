BEGIN;
CREATE TABLE public.piece_version_programming_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  piece_technique_version_id uuid NOT NULL UNIQUE REFERENCES public.piece_technique_versions(id),
  assignee_id integer NOT NULL REFERENCES public.users(id),
  estimated_hours numeric(12,3) NOT NULL CHECK(estimated_hours>0),
  status text NOT NULL DEFAULT 'TODO' CHECK(status IN ('TODO','DONE')),
  program_reference text,
  completed_at timestamptz,
  completed_by integer REFERENCES public.users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by integer NOT NULL REFERENCES public.users(id),
  CHECK(status<>'DONE' OR (length(trim(program_reference))>0 AND completed_at IS NOT NULL AND completed_by IS NOT NULL))
);
CREATE TABLE public.of_stock_reuse_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  of_id bigint NOT NULL REFERENCES public.ordres_fabrication(id),
  target_version_id uuid NOT NULL REFERENCES public.piece_technique_versions(id),
  source_version_id uuid REFERENCES public.piece_technique_versions(id),
  lot_id uuid NOT NULL REFERENCES public.lots(id),
  stock_batch_id uuid NOT NULL REFERENCES public.stock_batches(id),
  quantity numeric(18,3) NOT NULL CHECK(quantity>0),
  disposition text NOT NULL CHECK(disposition IN ('REUSE','REWORK')),
  justification text NOT NULL CHECK(length(trim(justification))>=3),
  approval_reference text NOT NULL CHECK(length(trim(approval_reference))>=3),
  reservation_id uuid REFERENCES public.stock_reservations(id),
  idempotency_key uuid NOT NULL UNIQUE,
  request_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by integer NOT NULL REFERENCES public.users(id),
  CHECK(disposition<>'REUSE' OR reservation_id IS NOT NULL)
);
CREATE TABLE public.production_consolidation_component_transfers (
  consolidation_id uuid NOT NULL REFERENCES public.production_consolidations(id),
  requirement_id uuid NOT NULL REFERENCES public.of_component_requirements(id),
  source_of_id bigint NOT NULL REFERENCES public.ordres_fabrication(id),
  PRIMARY KEY(consolidation_id,requirement_id)
);

-- Guard new execution commands even when the display flag is switched off.
CREATE FUNCTION public.fn_guard_preparation_execution_712() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target bigint; o public.ordres_fabrication; execution boolean:=false; task uuid;
BEGIN
  IF TG_TABLE_NAME='ordres_fabrication' THEN
    IF NEW.statut IS NOT DISTINCT FROM OLD.statut OR NEW.statut IN ('BROUILLON','ANNULE') THEN RETURN NEW; END IF;
    target:=NEW.id; execution:=NEW.statut='EN_COURS';
  ELSIF TG_TABLE_NAME='planning_events' THEN
    IF NEW.archived_at IS NOT NULL OR NEW.status='CANCELLED' THEN RETURN NEW; END IF;
    target:=COALESCE((SELECT of_id FROM public.of_operations WHERE id=NEW.of_operation_id),NEW.of_id);
  ELSIF TG_TABLE_NAME='of_operations' THEN
    IF NEW.status IN ('TODO','READY','CANCELLED') OR (TG_OP='UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status) THEN RETURN NEW; END IF;
    target:=NEW.of_id; execution:=true;
  ELSIF TG_TABLE_NAME='of_time_logs' THEN
    target:=(SELECT of_id FROM public.of_operations WHERE id=NEW.of_operation_id); execution:=true;
  ELSE target:=NEW.of_id; execution:=true;
  END IF;
  SELECT * INTO o FROM public.ordres_fabrication WHERE id=target FOR UPDATE;
  IF o.preparation_rules_version IS NULL THEN RETURN NEW; END IF;
  IF o.technical_readiness<>'VALIDATED' OR o.technical_snapshot_sha256 IS NULL
     OR NOT EXISTS(SELECT 1 FROM public.of_self_inspection_sheets s WHERE s.id=NULLIF(o.technical_preparation->>'self_inspection_sheet_id','')::uuid AND s.of_id=o.id AND s.state='READY') THEN
    RAISE EXCEPTION 'OF_PREPARATION_REQUIRED: terminer et valider le dossier de préparation' USING ERRCODE='23514';
  END IF;
  task:=NULLIF(o.technical_snapshot->'preparation_decisions'->'programming'->>'task_id','')::uuid;
  IF execution AND task IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.piece_version_programming_tasks WHERE id=task AND status='DONE') THEN
    RAISE EXCEPTION 'OF_PROGRAMMING_REQUIRED: terminer la programmation avant démarrage' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DO $$ DECLARE tab text; BEGIN
  FOREACH tab IN ARRAY ARRAY['planning_events','of_operations','of_time_logs','production_pointages','production_quantity_declarations'] LOOP
    EXECUTE format('CREATE TRIGGER guard_preparation_execution_712 BEFORE INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.fn_guard_preparation_execution_712()',tab);
  END LOOP;
END $$;
CREATE TRIGGER guard_preparation_execution_712 BEFORE UPDATE ON public.ordres_fabrication FOR EACH ROW EXECUTE FUNCTION public.fn_guard_preparation_execution_712();

CREATE FUNCTION public.fn_guard_consolidation_producer_712() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.quantite_lancee IS DISTINCT FROM OLD.quantite_lancee AND EXISTS(SELECT 1 FROM public.production_consolidations WHERE producer_of_id=NEW.id AND state='ACTIVE') THEN
    RAISE EXCEPTION 'CONSOLIDATION_QUANTITY_LOCKED: dissoudre le regroupement avant de modifier son besoin' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_consolidation_producer_712 BEFORE UPDATE ON public.ordres_fabrication FOR EACH ROW EXECUTE FUNCTION public.fn_guard_consolidation_producer_712();

CREATE FUNCTION public.fn_guard_consolidation_allocation_712() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE producer bigint;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'CONSOLIDATION_HISTORY_IMMUTABLE: conserver les affectations annulées' USING ERRCODE='23514'; END IF;
  SELECT producer_of_id INTO producer FROM public.production_consolidations WHERE id=NEW.consolidation_id;
  IF EXISTS(SELECT 1 FROM public.production_consolidations WHERE producer_of_id=NEW.source_of_id)
    OR EXISTS(SELECT 1 FROM public.production_consolidation_allocations WHERE source_of_id=producer AND state='ACTIVE') THEN
    RAISE EXCEPTION 'CONSOLIDATION_CYCLE: un producteur ne peut être une demande regroupée' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_consolidation_allocation_712 BEFORE INSERT OR UPDATE OR DELETE ON public.production_consolidation_allocations FOR EACH ROW EXECUTE FUNCTION public.fn_guard_consolidation_allocation_712();
-- Cancelled, unmanufactured demand needs no fabricated technical evidence.
CREATE OR REPLACE FUNCTION public.fn_assert_of_technical_snapshot_coherence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_snapshot jsonb;
  v_version_id uuid;
  v_sha256 text;
  v_empty boolean;
  v_complete boolean;
BEGIN
  v_empty := NEW.piece_technique_version_id IS NULL
    AND NEW.technical_snapshot IS NULL
    AND NEW.technical_snapshot_sha256 IS NULL
    AND NEW.technical_snapshot_at IS NULL;
  v_complete := NEW.piece_technique_version_id IS NOT NULL
    AND NEW.technical_snapshot IS NOT NULL
    AND NEW.technical_snapshot_sha256 IS NOT NULL
    AND NEW.technical_snapshot_at IS NOT NULL;

  IF v_empty AND NEW.statut::text IN ('BROUILLON','ANNULE') THEN
    RETURN NULL;
  END IF;
  IF NOT v_complete THEN
    RAISE EXCEPTION 'OF technical snapshot fields must be all empty or all populated'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.statut::text NOT IN ('BROUILLON','ANNULE') AND NEW.technical_readiness <> 'VALIDATED' THEN
    RAISE EXCEPTION 'An OF cannot leave BROUILLON before technical validation'
      USING ERRCODE = '23514';
  END IF;

  SELECT s.snapshot, s.piece_technique_version_id, s.snapshot_sha256
    INTO v_snapshot, v_version_id, v_sha256
    FROM public.of_technical_snapshots s
   WHERE s.of_id = NEW.id;
  IF NOT FOUND
     OR v_version_id IS DISTINCT FROM NEW.piece_technique_version_id
     OR v_snapshot IS DISTINCT FROM NEW.technical_snapshot
     OR v_sha256 IS DISTINCT FROM NEW.technical_snapshot_sha256 THEN
    RAISE EXCEPTION 'OF technical snapshot companion is missing or inconsistent'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
COMMIT;
