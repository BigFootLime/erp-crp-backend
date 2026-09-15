BEGIN;
SET LOCAL lock_timeout = '10s';

ALTER TABLE public.production_pointages ADD COLUMN IF NOT EXISTS corrects_pointage_id uuid
  REFERENCES public.production_pointages(id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX IF NOT EXISTS production_pointages_corrects_unique
  ON public.production_pointages(corrects_pointage_id) WHERE corrects_pointage_id IS NOT NULL;
-- A session predecessor may be a pause/change, not a correction. Recover only explicit journal links.
UPDATE public.production_pointages p SET corrects_pointage_id=e.original_id
FROM (SELECT pointage_id,(new_values->>'corrects')::uuid AS original_id
  FROM public.production_pointage_events WHERE event_type='CORRECT'
  AND new_values->>'corrects' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') e
WHERE p.id=e.pointage_id AND p.corrects_pointage_id IS NULL;

ALTER TABLE public.planning_estimation_observations
  ADD COLUMN IF NOT EXISTS context_snapshot jsonb,
  ADD COLUMN IF NOT EXISTS pointage_ids uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS declaration_ids uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS calculated_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS planning_observations_eligible_idx
  ON public.planning_estimation_observations(context_key,recorded_at DESC,id)
  WHERE measurement_kind='MACHINE' AND validated_at IS NOT NULL AND excluded_reason IS NULL;

CREATE TABLE IF NOT EXISTS public.planning_learning_jobs (
  operation_id uuid PRIMARY KEY REFERENCES public.of_operations(id) ON DELETE CASCADE,
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  attempts integer NOT NULL DEFAULT 0,
  last_error text
);
CREATE TABLE IF NOT EXISTS public.planning_learning_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  calculated_at timestamptz,
  last_error text,
  processed_operations bigint NOT NULL DEFAULT 0
);
INSERT INTO public.planning_learning_state(singleton) VALUES(true) ON CONFLICT DO NOTHING;

-- First forecast made before execution: immutable baseline for prospective accuracy.
CREATE TABLE IF NOT EXISTS public.planning_duration_predictions (
  operation_id uuid PRIMARY KEY REFERENCES public.of_operations(id) ON DELETE CASCADE,
  context_key text NOT NULL,
  unit_minutes double precision NOT NULL CHECK(unit_minutes>=0),
  setup_minutes double precision NOT NULL CHECK(setup_minutes>=0),
  routing_unit_minutes double precision NOT NULL CHECK(routing_unit_minutes>=0),
  policy text NOT NULL,
  observations integer NOT NULL,
  source_revision bigint NOT NULL,
  predicted_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.planning_duration_context(operation uuid, machine uuid, poste uuid)
RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN o.piece_technique_version_id IS NOT NULL AND o.technical_snapshot_sha256 IS NOT NULL
    AND COALESCE(machine,p.machine_id) IS NOT NULL THEN jsonb_build_object(
      'pieceId',o.piece_technique_id::text,'revision',o.piece_technique_version_id::text,
      'phase',op.phase,'machineId',COALESCE(machine,p.machine_id)::text,
      'configuration',COALESCE(t.configuration_key,'')) ELSE NULL END
  FROM public.of_operations op JOIN public.ordres_fabrication o ON o.id=op.of_id
  LEFT JOIN public.postes p ON p.id=poste
  LEFT JOIN public.planning_tasks t ON t.operation_id=op.id
  WHERE op.id=operation
$$;

CREATE OR REPLACE FUNCTION public.planning_capture_duration_context() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE bucket text; original public.production_pointages%ROWTYPE;
BEGIN
  IF TG_OP='UPDATE' AND (NEW.operation_id,NEW.machine_id,NEW.poste_id,NEW.activity_code)
    IS NOT DISTINCT FROM (OLD.operation_id,OLD.machine_id,OLD.poste_id,OLD.activity_code) THEN RETURN NEW; END IF;
  IF TG_OP='INSERT' AND NEW.corrects_pointage_id IS NOT NULL THEN
    SELECT * INTO original FROM public.production_pointages WHERE id=NEW.corrects_pointage_id;
    IF (NEW.operation_id,NEW.machine_id,NEW.poste_id,NEW.activity_code)
      IS NOT DISTINCT FROM (original.operation_id,original.machine_id,original.poste_id,original.activity_code)
      AND original.context_snapshot ? 'duration_learning' THEN
      NEW.context_snapshot := COALESCE(NEW.context_snapshot,'{}') || jsonb_build_object('duration_learning',original.context_snapshot->'duration_learning');
      RETURN NEW;
    END IF;
  END IF;
  SELECT CASE WHEN code='REWORK' THEN 'UNKNOWN'
    WHEN counts_machine_time AND code='SETUP' THEN 'SETUP'
    WHEN counts_machine_time AND is_productive THEN 'PRODUCTION'
    ELSE 'EXCLUDED' END INTO bucket FROM public.production_activity_categories WHERE code=NEW.activity_code;
  NEW.context_snapshot := COALESCE(NEW.context_snapshot,'{}') || jsonb_build_object('duration_learning',
    jsonb_build_object('context',public.planning_duration_context(NEW.operation_id,NEW.machine_id,NEW.poste_id),
      'bucket',COALESCE(bucket,'UNKNOWN')));
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS planning_capture_duration_context ON public.production_pointages;
CREATE TRIGGER planning_capture_duration_context BEFORE INSERT OR UPDATE OF operation_id,machine_id,poste_id,activity_code
  ON public.production_pointages FOR EACH ROW EXECUTE FUNCTION public.planning_capture_duration_context();

CREATE OR REPLACE FUNCTION public.planning_queue_learning(operation uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF operation IS NULL OR NOT EXISTS(SELECT 1 FROM public.of_operations WHERE id=operation) THEN RETURN; END IF;
  UPDATE public.planning_central_settings SET revision=revision+1,updated_at=clock_timestamp() WHERE singleton;
  INSERT INTO public.planning_learning_jobs(operation_id) VALUES(operation)
    ON CONFLICT(operation_id) DO UPDATE SET requested_at=clock_timestamp(),last_error=NULL;
  -- Invalid data stops participating immediately, even when the worker is down.
  UPDATE public.planning_estimation_observations SET excluded_reason='SOURCE_CHANGED',validated_at=NULL
    WHERE operation_id=operation AND excluded_reason IS DISTINCT FROM 'SOURCE_CHANGED';
END $$;

CREATE OR REPLACE FUNCTION public.planning_invalidate_learning() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE before_row jsonb:=to_jsonb(OLD); after_row jsonb:=to_jsonb(NEW); operation uuid;
BEGIN
  IF TG_TABLE_NAME IN ('production_pointages','production_quantity_declarations','planning_tasks') THEN
    IF TG_TABLE_NAME='planning_tasks' AND TG_OP='UPDATE' AND after_row->'configuration_key' IS NOT DISTINCT FROM before_row->'configuration_key' THEN RETURN NULL; END IF;
    FOR operation IN SELECT DISTINCT value::uuid FROM jsonb_array_elements_text(jsonb_build_array(before_row->>'operation_id',after_row->>'operation_id')) WHERE value IS NOT NULL LOOP
      PERFORM public.planning_queue_learning(operation);
    END LOOP;
  ELSIF TG_TABLE_NAME='of_operations' THEN
    PERFORM public.planning_queue_learning(COALESCE(after_row->>'id',before_row->>'id')::uuid);
  ELSIF TG_TABLE_NAME IN ('ordres_fabrication','of_revisions') THEN
    FOR operation IN SELECT id FROM public.of_operations WHERE of_id=CASE WHEN TG_TABLE_NAME='of_revisions'
      THEN COALESCE(after_row->>'of_id',before_row->>'of_id')::bigint ELSE COALESCE(after_row->>'id',before_row->>'id')::bigint END LOOP
      PERFORM public.planning_queue_learning(operation);
    END LOOP;
  ELSIF TG_TABLE_NAME='of_time_logs' THEN
    FOR operation IN SELECT DISTINCT value::uuid FROM jsonb_array_elements_text(jsonb_build_array(before_row->>'of_operation_id',after_row->>'of_operation_id')) WHERE value IS NOT NULL LOOP
      PERFORM public.planning_queue_learning(operation);
    END LOOP;
  END IF;
  RETURN NULL;
END $$;
DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['production_pointages','production_quantity_declarations','planning_tasks','of_operations','ordres_fabrication','of_revisions','of_time_logs'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS planning_invalidate_learning ON public.%I',table_name);
    EXECUTE format('CREATE TRIGGER planning_invalidate_learning AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.planning_invalidate_learning()',table_name);
  END LOOP;
END $$;

DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='cerp_app') THEN
    GRANT SELECT,INSERT,UPDATE,DELETE ON public.planning_learning_jobs TO cerp_app;
    GRANT SELECT,UPDATE ON public.planning_learning_state TO cerp_app;
    GRANT SELECT,INSERT ON public.planning_duration_predictions TO cerp_app;
    GRANT EXECUTE ON FUNCTION public.planning_duration_context(uuid,uuid,uuid),public.planning_queue_learning(uuid) TO cerp_app;
  END IF;
END $$;
-- Historical reconstruction is an explicit, resumable command, not an unbounded migration.
COMMIT;
