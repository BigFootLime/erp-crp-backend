-- #1273: execution evidence for a completed external operation is not a local
-- machining declaration, a time log, or a finished-goods stock movement.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';
CREATE TABLE IF NOT EXISTS public.subcontract_operation_completions (
  operation_id uuid PRIMARY KEY REFERENCES public.of_operations(id) ON DELETE RESTRICT,
  qty_good numeric(14,4) NOT NULL CHECK(qty_good>0),
  unit text NOT NULL CHECK(unit='U'),
  started_at timestamptz NOT NULL,
  ended_at timestamptz NOT NULL CHECK(ended_at>=started_at),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  recorded_by integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  evidence jsonb NOT NULL CHECK(COALESCE(jsonb_typeof(evidence)='object'
    AND jsonb_typeof(evidence->'packageIds')='array' AND jsonb_array_length(evidence->'packageIds')>0,FALSE))
);
CREATE OR REPLACE FUNCTION public.guard_subcontract_completion_1273() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'SUBCONTRACT_COMPLETION_IMMUTABLE' USING ERRCODE='55000'; END IF;
  IF EXISTS(SELECT 1 FROM public.production_quantity_declarations WHERE operation_id=NEW.operation_id) THEN
    RAISE EXCEPTION 'SUBCONTRACT_LOCAL_OUTPUT_EXISTS' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.of_operations op JOIN public.ordres_fabrication o ON o.id=op.of_id
    WHERE op.id=NEW.operation_id AND o.quantite_lancee=NEW.qty_good AND op.status::text NOT IN('CANCELLED','BLOCKED')
      AND o.statut::text NOT IN('ANNULE','CLOTURE')
      AND(op.revision_id IS NULL OR EXISTS(SELECT 1 FROM public.of_revisions r WHERE r.id=op.revision_id AND r.statut='ACTIVE'))
      AND EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(o.technical_snapshot->'operations','[]'::jsonb)) frozen
        WHERE frozen->>'phase'=op.phase::text AND frozen->>'type_operation'='SOUS_TRAITANCE')) THEN
    RAISE EXCEPTION 'SUBCONTRACT_COMPLETION_OPERATION_INVALID' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS(
    WITH packages AS(
      SELECT p.id,p.status,p.unit,
        COALESCE(sum(e.qty) FILTER(WHERE e.event_type='ISSUE'),0) AS issued,
        COALESCE(sum(e.qty) FILTER(WHERE e.event_type='RETURN'),0) AS returned
      FROM public.subcontract_work_packages p LEFT JOIN public.subcontract_work_package_ledger e ON e.package_id=p.id
      WHERE p.of_operation_id=NEW.operation_id GROUP BY p.id
    )
    SELECT 1 FROM packages HAVING count(*) FILTER(WHERE status='CLOSED')>0
      AND bool_and(status='CLOSED' OR(status='CANCELLED' AND issued=0 AND returned=0))
      AND bool_and(issued=returned) AND sum(issued)=NEW.qty_good
      AND bool_and(upper(trim(unit))='U')
  ) OR NEW.qty_good<>(SELECT COALESCE(sum(origin.quantity),0) FROM public.reception_subcontract_origins origin
      JOIN public.subcontract_work_packages p ON p.id=origin.package_id WHERE p.of_operation_id=NEW.operation_id)
    OR NEW.qty_good<>(SELECT COALESCE(sum(b.released_quantity),0) FROM public.production_transfer_batches b
      JOIN public.reception_subcontract_origins origin ON origin.id=b.subcontract_origin_id
      JOIN public.subcontract_work_packages p ON p.id=origin.package_id
      WHERE p.of_operation_id=NEW.operation_id AND b.operation_id=NEW.operation_id) THEN
    RAISE EXCEPTION 'SUBCONTRACT_COMPLETION_CUSTODY_INVALID' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS subcontract_completion_1273 ON public.subcontract_operation_completions;
CREATE TRIGGER subcontract_completion_1273 BEFORE INSERT OR UPDATE OR DELETE ON public.subcontract_operation_completions
  FOR EACH ROW EXECUTE FUNCTION public.guard_subcontract_completion_1273();
CREATE OR REPLACE FUNCTION public.guard_external_local_output_1273() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM public.subcontract_operation_completions WHERE operation_id=NEW.operation_id) THEN
    RAISE EXCEPTION 'SUBCONTRACT_OUTPUT_ALREADY_RECORDED' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS external_local_output_1273 ON public.production_quantity_declarations;
CREATE TRIGGER external_local_output_1273 BEFORE INSERT OR UPDATE ON public.production_quantity_declarations
  FOR EACH ROW EXECUTE FUNCTION public.guard_external_local_output_1273();
-- Exactly one source for each operation. Existing local output stays unchanged;
-- the service and database guard forbid adding completion over legacy output.
CREATE OR REPLACE VIEW public.production_operation_quantities AS
  SELECT operation_id,sum(qty_good) AS good,sum(qty_scrap) AS scrap,
    sum(qty_rework) AS rework,sum(qty_pending_control) AS pending
  FROM public.production_quantity_declarations WHERE operation_id IS NOT NULL
    AND NOT EXISTS(SELECT 1 FROM public.subcontract_operation_completions c WHERE c.operation_id=production_quantity_declarations.operation_id)
  GROUP BY operation_id
  UNION ALL SELECT operation_id,qty_good,0::numeric,0::numeric,0::numeric FROM public.subcontract_operation_completions;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='cerp_app') THEN
  ALTER TABLE public.subcontract_operation_completions OWNER TO cerp_app;
  ALTER VIEW public.production_operation_quantities OWNER TO cerp_app;
  GRANT SELECT,INSERT ON public.subcontract_operation_completions TO cerp_app;
  GRANT SELECT ON public.production_operation_quantities TO cerp_app;
END IF; END $$;
COMMIT;
