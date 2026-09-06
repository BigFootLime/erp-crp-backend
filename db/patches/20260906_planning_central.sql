-- Planning central P2/P6 (#717): additive metadata, identity adapters and durable invalidation.
-- No stock, production quantity, customer promise or committed slot is changed by this patch.
BEGIN;
DO $$ BEGIN
  IF to_regclass('public.of_operations') IS NULL OR to_regclass('public.programmations') IS NULL
     OR to_regclass('public.internal_contract_of_allocations') IS NULL THEN
    RAISE EXCEPTION 'Planning central requires the production, programming and assembly patches';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.planning_central_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  activation text NOT NULL DEFAULT 'OBSERVE' CHECK (activation IN ('OBSERVE','READ','SIMULATE','COMMIT','EXECUTE','LEARN')),
  revision bigint NOT NULL DEFAULT 1,
  estimation_policy text NOT NULL DEFAULT 'cerp-duration-v1',
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.planning_central_settings(singleton) VALUES (true) ON CONFLICT DO NOTHING;

-- A key references exactly one canonical business object. No quantities or actual time copied here.
CREATE TABLE IF NOT EXISTS public.planning_tasks (
  id text PRIMARY KEY,
  operation_id uuid UNIQUE REFERENCES public.of_operations(id) ON DELETE CASCADE,
  programming_id uuid UNIQUE REFERENCES public.programmations(id) ON DELETE CASCADE,
  version_programming_id uuid UNIQUE REFERENCES public.piece_version_programming_tasks(id) ON DELETE CASCADE,
  draft_of_id bigint UNIQUE REFERENCES public.ordres_fabrication(id) ON DELETE CASCADE,
  envelope_minutes numeric(14,4) CHECK (envelope_minutes >= 0),
  earliest_start timestamptz,
  forecast_start timestamptz,
  forecast_end timestamptz,
  committed_start timestamptz,
  committed_end timestamptz,
  blockers text[] NOT NULL DEFAULT '{}',
  locked boolean NOT NULL DEFAULT false,
  preparation_confirmed boolean NOT NULL DEFAULT false,
  configuration_key text NOT NULL DEFAULT '',
  version bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT planning_tasks_source_ck CHECK (
    num_nonnulls(operation_id, programming_id, version_programming_id, draft_of_id) = 1 AND
    (operation_id IS NULL OR id = 'op:' || operation_id::text) AND
    (programming_id IS NULL OR id = 'program:' || programming_id::text) AND
    (version_programming_id IS NULL OR id = 'version-program:' || version_programming_id::text) AND
    (draft_of_id IS NULL OR id = 'draft:' || draft_of_id::text)),
  CONSTRAINT planning_tasks_commitment_ck CHECK (
    (committed_start IS NULL AND committed_end IS NULL) OR
    (committed_start IS NOT NULL AND committed_end > committed_start)),
  CONSTRAINT planning_tasks_forecast_ck CHECK (
    (forecast_start IS NULL AND forecast_end IS NULL) OR
    (forecast_start IS NOT NULL AND forecast_end > forecast_start))
);
INSERT INTO public.planning_tasks(id, operation_id)
  SELECT 'op:' || id::text, id FROM public.of_operations ON CONFLICT DO NOTHING;
INSERT INTO public.planning_tasks(id, programming_id)
  SELECT 'program:' || id::text, id FROM public.programmations ON CONFLICT DO NOTHING;
INSERT INTO public.planning_tasks(id, version_programming_id)
  SELECT 'version-program:' || id::text, id FROM public.piece_version_programming_tasks ON CONFLICT DO NOTHING;
INSERT INTO public.planning_tasks(id, draft_of_id)
  SELECT 'draft:' || id::text, id FROM public.ordres_fabrication ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS public.planning_operation_dependencies (
  predecessor_id text NOT NULL REFERENCES public.planning_tasks(id) ON DELETE CASCADE,
  successor_id text NOT NULL REFERENCES public.planning_tasks(id) ON DELETE CASCADE,
  transfer_quantity numeric(18,6) CHECK (transfer_quantity > 0),
  lag_minutes numeric(14,4) NOT NULL DEFAULT 0 CHECK (lag_minutes >= 0),
  created_by integer REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (predecessor_id, successor_id),
  CHECK (predecessor_id <> successor_id)
);
CREATE INDEX IF NOT EXISTS planning_dependencies_successor_idx ON public.planning_operation_dependencies(successor_id);
CREATE OR REPLACE FUNCTION public.planning_check_dependency_cycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('planning-dependencies', 0));
  IF EXISTS (WITH RECURSIVE successors(id) AS (
    SELECT NEW.successor_id
    UNION SELECT d.successor_id FROM public.planning_operation_dependencies d JOIN successors s ON d.predecessor_id=s.id
  ) SELECT 1 FROM successors WHERE id=NEW.predecessor_id) THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='PLANNING_DEPENDENCY_CYCLE';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS planning_dependency_cycle ON public.planning_operation_dependencies;
CREATE TRIGGER planning_dependency_cycle BEFORE INSERT OR UPDATE ON public.planning_operation_dependencies
  FOR EACH ROW EXECUTE FUNCTION public.planning_check_dependency_cycle();

-- Released transfer batches belong to production; their quantity never creates finished goods stock.
CREATE TABLE IF NOT EXISTS public.production_transfer_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id uuid NOT NULL REFERENCES public.of_operations(id) ON DELETE RESTRICT,
  successor_operation_id uuid NOT NULL REFERENCES public.of_operations(id) ON DELETE RESTRICT,
  quantity numeric(18,6) NOT NULL CHECK (quantity > 0),
  released_quantity numeric(18,6) NOT NULL DEFAULT 0 CHECK (released_quantity >= 0 AND released_quantity <= quantity),
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by integer REFERENCES public.users(id),
  CHECK (operation_id <> successor_operation_id)
);

-- Reuse the existing civil calendar definitions, including programming closures.
CREATE TABLE IF NOT EXISTS public.planning_resource_calendars (
  resource_id text PRIMARY KEY,
  machine_id uuid UNIQUE REFERENCES public.machines(id) ON DELETE RESTRICT,
  poste_id uuid UNIQUE REFERENCES public.postes(id) ON DELETE RESTRICT,
  user_id integer UNIQUE REFERENCES public.users(id) ON DELETE RESTRICT,
  calendar_id uuid NOT NULL REFERENCES public.programmation_calendars(id) ON DELETE RESTRICT,
  display_label text,
  version bigint NOT NULL DEFAULT 1,
  CHECK (num_nonnulls(machine_id,poste_id,user_id)=1),
  CHECK ((machine_id IS NULL OR resource_id='machine:' || machine_id::text) AND
         (poste_id IS NULL OR resource_id='poste:' || poste_id::text) AND
         (user_id IS NULL OR resource_id='person:' || user_id::text))
);
CREATE TABLE IF NOT EXISTS public.planning_resource_absences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_id text NOT NULL REFERENCES public.planning_resource_calendars(resource_id),
  start_ts timestamptz NOT NULL,
  end_ts timestamptz NOT NULL CHECK (end_ts > start_ts),
  reason text NOT NULL CHECK (length(btrim(reason)) > 0),
  version bigint NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS planning_resource_absences_window_idx ON public.planning_resource_absences(resource_id,start_ts,end_ts);

CREATE TABLE IF NOT EXISTS public.planning_estimation_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id uuid NOT NULL REFERENCES public.of_operations(id) ON DELETE RESTRICT,
  context_key text NOT NULL,
  measurement_kind text NOT NULL CHECK (measurement_kind IN ('MACHINE','HUMAN','SUPPLIER_LEAD')),
  productive_minutes numeric(16,6) NOT NULL CHECK (productive_minutes >= 0),
  attributable_quantity numeric(18,6) NOT NULL CHECK (attributable_quantity >= 0),
  setup_minutes numeric(16,6) CHECK (setup_minutes >= 0),
  validated_at timestamptz,
  excluded_reason text,
  source_revision text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(operation_id, measurement_kind, context_key)
);
CREATE INDEX IF NOT EXISTS planning_observations_context_idx ON public.planning_estimation_observations(context_key,recorded_at DESC);

CREATE TABLE IF NOT EXISTS public.planning_simulations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by integer NOT NULL REFERENCES public.users(id),
  base_revision bigint NOT NULL,
  request jsonb NOT NULL,
  result jsonb NOT NULL,
  status text NOT NULL DEFAULT 'PREVIEW' CHECK (status IN ('PREVIEW','APPLIED','CANCELLED','OBSOLETE')),
  compensates_id uuid REFERENCES public.planning_simulations(id),
  applied_revision bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz
);
CREATE TABLE IF NOT EXISTS public.planning_command_idempotency (
  actor_id integer NOT NULL REFERENCES public.users(id),
  command text NOT NULL,
  key text NOT NULL CHECK (length(key) BETWEEN 8 AND 160),
  fingerprint text NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(actor_id, command, key)
);
CREATE TABLE IF NOT EXISTS public.planning_recalculation_jobs (
  id bigserial PRIMARY KEY,
  entity_table text NOT NULL,
  entity_id text NOT NULL,
  source_revision bigint NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  last_error text
);
CREATE INDEX IF NOT EXISTS planning_recalculation_pending_idx ON public.planning_recalculation_jobs(id) WHERE processed_at IS NULL;

CREATE OR REPLACE FUNCTION public.planning_register_task() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='of_operations' THEN
    INSERT INTO public.planning_tasks(id,operation_id) VALUES ('op:'||NEW.id::text,NEW.id) ON CONFLICT DO NOTHING;
  ELSIF TG_TABLE_NAME='programmations' THEN
    INSERT INTO public.planning_tasks(id,programming_id) VALUES ('program:'||NEW.id::text,NEW.id) ON CONFLICT DO NOTHING;
  ELSIF TG_TABLE_NAME='piece_version_programming_tasks' THEN
    INSERT INTO public.planning_tasks(id,version_programming_id) VALUES ('version-program:'||NEW.id::text,NEW.id) ON CONFLICT DO NOTHING;
  ELSE
    INSERT INTO public.planning_tasks(id,draft_of_id) VALUES ('draft:'||NEW.id::text,NEW.id) ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['of_operations','programmations','piece_version_programming_tasks','ordres_fabrication'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS planning_register_task ON public.%I',t);
    EXECUTE format('CREATE TRIGGER planning_register_task AFTER INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION public.planning_register_task()',t);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.planning_invalidate() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE rev bigint; entity text;
BEGIN
  -- All writers, including legacy routes, advance the same durable revision.
  UPDATE public.planning_central_settings SET revision=revision+1,updated_at=clock_timestamp() WHERE singleton RETURNING revision INTO rev;
  entity := COALESCE(to_jsonb(NEW)->>'id',to_jsonb(OLD)->>'id',
                     to_jsonb(NEW)->>'resource_id',to_jsonb(OLD)->>'resource_id','all');
  INSERT INTO public.planning_recalculation_jobs(entity_table,entity_id,source_revision)
    VALUES(TG_TABLE_NAME,entity,rev);
  RETURN NULL;
END $$;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['of_operations','ordres_fabrication','programmations','piece_version_programming_tasks','planning_events',
    'production_pointages','production_quantity_declarations','stock_reservations','internal_contract_of_allocations',
    'of_component_requirements','planning_operation_dependencies','production_transfer_batches',
    'planning_resource_calendars','planning_resource_absences','programmation_calendars','programmation_calendar_closures',
    'subcontract_work_package_events'] LOOP
    IF to_regclass('public.'||t) IS NOT NULL THEN
      EXECUTE format('DROP TRIGGER IF EXISTS planning_invalidate ON public.%I',t);
      EXECUTE format('CREATE TRIGGER planning_invalidate AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.planning_invalidate()',t);
    END IF;
  END LOOP;
END $$;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='cerp_app') THEN
    GRANT SELECT,INSERT,UPDATE,DELETE ON public.planning_tasks,public.planning_operation_dependencies,
      public.production_transfer_batches,public.planning_resource_calendars,public.planning_resource_absences,
      public.planning_estimation_observations,public.planning_simulations,public.planning_command_idempotency,
      public.planning_recalculation_jobs TO cerp_app;
    GRANT SELECT,UPDATE ON public.planning_central_settings TO cerp_app;
    GRANT USAGE,SELECT ON SEQUENCE public.planning_recalculation_jobs_id_seq TO cerp_app;
  END IF;
END $$;
COMMIT;
