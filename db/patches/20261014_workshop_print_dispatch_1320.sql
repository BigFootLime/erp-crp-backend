-- A committed production slot queues one fabrication packet per OF edition.
-- No historical backfill, stock change, paper confirmation or automatic reprint.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
CREATE TABLE IF NOT EXISTS public.of_workshop_print_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  of_id bigint NOT NULL REFERENCES public.ordres_fabrication(id) ON DELETE RESTRICT,
  revision_rank integer NOT NULL CHECK(revision_rank>=0),
  technical_sha256 text NOT NULL CHECK(technical_sha256 ~ '^[a-f0-9]{64}$'),
  source_kind text NOT NULL CHECK(source_kind IN('EVENT','EXTERNAL_TASK')),
  source_id text NOT NULL CHECK(length(source_id) BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  planning_actor_id integer REFERENCES public.users(id) ON DELETE RESTRICT,
  claimed_by integer REFERENCES public.users(id) ON DELETE RESTRICT,
  device_id uuid,
  claimed_at timestamptz,
  print_intent_id uuid UNIQUE REFERENCES public.of_document_print_intents(id) ON DELETE RESTRICT,
  folder_id uuid REFERENCES public.of_workshop_folders(id) ON DELETE RESTRICT,
  state text NOT NULL DEFAULT 'PENDING' CHECK(state IN('PENDING','CLAIMED','REVIEW','SPOOLED')),
  CHECK((claimed_by IS NULL AND device_id IS NULL AND claimed_at IS NULL AND state='PENDING') OR
    (claimed_by IS NOT NULL AND device_id IS NOT NULL AND claimed_at IS NOT NULL AND state<>'PENDING')),
  CHECK((print_intent_id IS NULL)=(folder_id IS NULL)),
  UNIQUE(of_id,revision_rank,technical_sha256),
  UNIQUE(id,print_intent_id,claimed_by,device_id)
);
CREATE INDEX IF NOT EXISTS of_workshop_print_jobs_pending_1320 ON public.of_workshop_print_jobs(created_at,id) WHERE state<>'SPOOLED';
CREATE TABLE IF NOT EXISTS public.of_workshop_print_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES public.of_workshop_print_jobs(id) ON DELETE RESTRICT,
  intent_id uuid NOT NULL REFERENCES public.of_document_print_intents(id) ON DELETE RESTRICT,
  device_id uuid NOT NULL,
  actor_id integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  outcome text NOT NULL CHECK(outcome IN('SPOOLED','FAILED','UNCERTAIN')),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(job_id,intent_id,actor_id,device_id) REFERENCES public.of_workshop_print_jobs(id,print_intent_id,claimed_by,device_id) ON DELETE RESTRICT,
  UNIQUE(job_id,intent_id,outcome)
);
DROP TRIGGER IF EXISTS trg_workshop_receipt_immutable_1320 ON public.of_workshop_print_receipts;
CREATE TRIGGER trg_workshop_receipt_immutable_1320 BEFORE UPDATE OR DELETE ON public.of_workshop_print_receipts
  FOR EACH ROW EXECUTE FUNCTION public.fn_of_print_evidence_immutable_1320();
CREATE OR REPLACE FUNCTION public.fn_workshop_job_guard_1320() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Workshop dispatch evidence cannot be deleted' USING ERRCODE='23514'; END IF;
  IF ROW(NEW.id,NEW.of_id,NEW.revision_rank,NEW.technical_sha256,NEW.source_kind,NEW.source_id,NEW.created_at,NEW.planning_actor_id)
    IS DISTINCT FROM ROW(OLD.id,OLD.of_id,OLD.revision_rank,OLD.technical_sha256,OLD.source_kind,OLD.source_id,OLD.created_at,OLD.planning_actor_id) OR
    (OLD.claimed_by IS NOT NULL AND ROW(NEW.claimed_by,NEW.device_id,NEW.claimed_at) IS DISTINCT FROM ROW(OLD.claimed_by,OLD.device_id,OLD.claimed_at)) OR
    (OLD.print_intent_id IS NOT NULL AND ROW(NEW.print_intent_id,NEW.folder_id) IS DISTINCT FROM ROW(OLD.print_intent_id,OLD.folder_id)) OR
    (OLD.state='SPOOLED' AND NEW.state<>'SPOOLED') THEN
    RAISE EXCEPTION 'Workshop dispatch identity and acknowledgement are immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.print_intent_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.of_document_print_intents i
    JOIN public.of_workshop_folder_prints p ON p.intent_id=i.id JOIN public.of_workshop_folders f ON f.id=p.folder_id
    JOIN public.of_revisions r ON r.id=i.revision_id
    WHERE i.id=NEW.print_intent_id AND i.of_id=NEW.of_id AND i.actor_id=NEW.claimed_by AND i.document_status='OFFICIEL'
      AND f.id=NEW.folder_id AND r.revision_rank=NEW.revision_rank) THEN
    RAISE EXCEPTION 'Workshop dispatch copy scope mismatch' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_workshop_job_guard_1320 ON public.of_workshop_print_jobs;
CREATE TRIGGER trg_workshop_job_guard_1320 BEFORE UPDATE OR DELETE ON public.of_workshop_print_jobs
  FOR EACH ROW EXECUTE FUNCTION public.fn_workshop_job_guard_1320();

CREATE OR REPLACE FUNCTION public.fn_queue_workshop_edition_1320(p_of bigint,p_kind text,p_source text,p_actor integer)
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE root public.ordres_fabrication%ROWTYPE; rank integer;
BEGIN
  SELECT * INTO root FROM public.ordres_fabrication WHERE id=p_of;
  IF NOT FOUND OR root.statut::text IN('ANNULE','ARCHIVE','TERMINE','CLOTURE') OR
    root.technical_readiness<>'VALIDATED' OR root.technical_snapshot_sha256 IS NULL THEN RETURN; END IF;
  SELECT COALESCE(max(revision_rank),0) INTO rank FROM public.of_revisions WHERE of_id=p_of AND statut='ACTIVE';
  INSERT INTO public.of_workshop_print_jobs(of_id,revision_rank,technical_sha256,source_kind,source_id,planning_actor_id)
    VALUES(p_of,rank,root.technical_snapshot_sha256,p_kind,p_source,p_actor) ON CONFLICT DO NOTHING;
END $$;
CREATE OR REPLACE FUNCTION public.fn_workshop_event_dispatch_1320() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP='UPDATE' AND OLD.kind::text='OF_OPERATION' AND OLD.status::text='PLANNED' AND OLD.archived_at IS NULL
    AND OLD.of_id=NEW.of_id AND OLD.of_operation_id=NEW.of_operation_id THEN RETURN NEW; END IF;
  IF NEW.kind::text='OF_OPERATION' AND NEW.status::text='PLANNED' AND NEW.archived_at IS NULL AND
    NEW.of_id IS NOT NULL AND NEW.of_operation_id IS NOT NULL AND NEW.end_ts>NEW.start_ts AND
    EXISTS(SELECT 1 FROM public.of_operations op WHERE op.id=NEW.of_operation_id AND op.of_id=NEW.of_id AND
      (op.revision_id IS NULL OR EXISTS(SELECT 1 FROM public.of_revisions r WHERE r.id=op.revision_id AND r.statut='ACTIVE'))) THEN
    PERFORM public.fn_queue_workshop_edition_1320(NEW.of_id,'EVENT',NEW.id::text,COALESCE(NEW.updated_by,NEW.created_by));
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_workshop_event_dispatch_1320 ON public.planning_events;
CREATE TRIGGER trg_workshop_event_dispatch_1320 AFTER INSERT OR UPDATE OF start_ts,end_ts,status,archived_at,of_id,of_operation_id ON public.planning_events
  FOR EACH ROW EXECUTE FUNCTION public.fn_workshop_event_dispatch_1320();
CREATE OR REPLACE FUNCTION public.fn_workshop_external_dispatch_1320() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE target bigint;
BEGIN
  IF TG_OP='UPDATE' AND OLD.operation_id=NEW.operation_id AND OLD.committed_start IS NOT NULL THEN RETURN NEW; END IF;
  IF NEW.operation_id IS NOT NULL AND NEW.committed_start IS NOT NULL AND NEW.committed_end>NEW.committed_start THEN
    SELECT op.of_id INTO target FROM public.of_operations op JOIN public.ordres_fabrication root ON root.id=op.of_id
      WHERE op.id=NEW.operation_id AND (op.revision_id IS NULL OR EXISTS(SELECT 1 FROM public.of_revisions r WHERE r.id=op.revision_id AND r.statut='ACTIVE'))
      AND EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(root.technical_snapshot->'operations','[]'::jsonb)) f
        WHERE f->>'phase'=op.phase::text AND f->>'type_operation'='SOUS_TRAITANCE');
    IF target IS NOT NULL THEN PERFORM public.fn_queue_workshop_edition_1320(target,'EXTERNAL_TASK',NEW.id,NULL); END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_workshop_external_dispatch_1320 ON public.planning_tasks;
CREATE TRIGGER trg_workshop_external_dispatch_1320 AFTER INSERT OR UPDATE OF committed_start,committed_end ON public.planning_tasks
  FOR EACH ROW EXECUTE FUNCTION public.fn_workshop_external_dispatch_1320();
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='cerp_app') THEN
  REVOKE ALL ON public.of_workshop_print_jobs,public.of_workshop_print_receipts FROM cerp_app;
  GRANT SELECT,INSERT ON public.of_workshop_print_jobs,public.of_workshop_print_receipts TO cerp_app;
  GRANT UPDATE(claimed_by,device_id,claimed_at,print_intent_id,folder_id,state) ON public.of_workshop_print_jobs TO cerp_app;
END IF; END $$;
COMMIT;
