-- A quantity extension is valid only together with its allocation, dossier and plan.
BEGIN;
SET LOCAL lock_timeout='5s';
CREATE TABLE public.production_recovery_consolidation_additions (
  id uuid PRIMARY KEY,
  recovery_id uuid NOT NULL REFERENCES public.delivery_urgency_recoveries(id) ON DELETE RESTRICT,
  consolidation_id uuid NOT NULL REFERENCES public.production_consolidations(id) ON DELETE RESTRICT,
  producer_of_id bigint NOT NULL REFERENCES public.ordres_fabrication(id) ON DELETE RESTRICT,
  recovery_of_id bigint NOT NULL REFERENCES public.ordres_fabrication(id) ON DELETE RESTRICT,
  previous_quantity numeric(18,3) NOT NULL CHECK(previous_quantity>0),
  additional_quantity numeric(18,3) NOT NULL CHECK(additional_quantity>0),
  new_quantity numeric(18,3) NOT NULL CHECK(new_quantity=previous_quantity+additional_quantity),
  allocation_id uuid NOT NULL UNIQUE REFERENCES public.production_consolidation_allocations(id) DEFERRABLE INITIALLY DEFERRED,
  dossier_validation_id uuid NOT NULL UNIQUE REFERENCES public.of_dossier_validations(id) DEFERRABLE INITIALLY DEFERRED,
  finish_before timestamptz NOT NULL,
  proposed_finish timestamptz NOT NULL CHECK(proposed_finish<finish_before),
  technical_hash text NOT NULL CHECK(length(technical_hash)=64),
  request_key uuid NOT NULL,
  request_hash text NOT NULL CHECK(length(request_hash)=64),
  preview_hash text NOT NULL CHECK(length(preview_hash)=64),
  base_planning_revision bigint NOT NULL,
  evidence jsonb NOT NULL CHECK(jsonb_typeof(evidence)='object'),
  response jsonb NOT NULL CHECK(jsonb_typeof(response)='object'),
  created_by integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),
  UNIQUE(created_by,request_key),
  UNIQUE(recovery_id,consolidation_id),
  CHECK(producer_of_id<>recovery_of_id)
);
CREATE INDEX production_recovery_consolidation_additions_producer_idx ON public.production_recovery_consolidation_additions(producer_of_id);
CREATE TRIGGER production_recovery_consolidation_additions_immutable BEFORE UPDATE OR DELETE
  ON public.production_recovery_consolidation_additions FOR EACH ROW EXECUTE FUNCTION public.prevent_material_debit_rewrite();

CREATE FUNCTION public.fn_recovery_consolidation_addition_1034() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE recovery record; producer record; source record; grouping record; resumed jsonb; prior jsonb; saved_events jsonb; saved_task jsonb; closed_count integer;
BEGIN
  SELECT g.* INTO grouping FROM public.production_consolidations g WHERE g.id=NEW.consolidation_id FOR UPDATE;
  SELECT r.*,request.status AS request_status INTO recovery FROM public.delivery_urgency_recoveries r
    JOIN public.delivery_urgency_requests request ON request.id=r.request_id WHERE r.id=NEW.recovery_id;
  SELECT * INTO producer FROM public.ordres_fabrication WHERE id=NEW.producer_of_id;
  SELECT * INTO source FROM public.ordres_fabrication WHERE id=NEW.recovery_of_id;
  IF NEW.created_xid IS DISTINCT FROM pg_current_xact_id() OR grouping.state IS DISTINCT FROM 'ACTIVE'
    OR grouping.producer_of_id IS DISTINCT FROM NEW.producer_of_id OR recovery.recovery_of_id IS DISTINCT FROM NEW.recovery_of_id
    OR recovery.request_status IS NULL OR recovery.request_status NOT IN('WAITING_PLANNER','APPROVED','WITHDRAWN')
    OR producer.statut::text NOT IN('BROUILLON','PLANIFIE','EN_COURS','EN_PAUSE') OR source.statut::text IS DISTINCT FROM 'BROUILLON'
    OR producer.quantite_lancee IS DISTINCT FROM NEW.previous_quantity OR source.quantite_lancee IS DISTINCT FROM NEW.additional_quantity
    OR recovery.quantity IS DISTINCT FROM NEW.additional_quantity OR producer.client_id IS NULL OR producer.client_id IS DISTINCT FROM source.client_id
    OR producer.article_id IS NULL OR producer.article_id IS DISTINCT FROM source.article_id
    OR producer.piece_technique_id IS DISTINCT FROM source.piece_technique_id
    OR producer.piece_technique_version_id IS NULL OR producer.piece_technique_version_id IS DISTINCT FROM source.piece_technique_version_id
    OR producer.technical_snapshot_sha256 IS DISTINCT FROM NEW.technical_hash OR source.technical_snapshot_sha256 IS DISTINCT FROM NEW.technical_hash
    OR NEW.finish_before>(recovery.protected_due_date::timestamp AT TIME ZONE 'Europe/Paris')
    OR NEW.finish_before>(recovery.initial_ar_due_date::timestamp AT TIME ZONE 'Europe/Paris')
    OR NEW.proposed_finish<=clock_timestamp()
    OR EXISTS(SELECT 1 FROM public.production_consolidation_allocations WHERE source_of_id=NEW.recovery_of_id AND state='ACTIVE')
    OR EXISTS(SELECT 1 FROM public.production_consolidations WHERE producer_of_id=NEW.recovery_of_id)
    OR EXISTS(SELECT 1 FROM public.production_consolidation_allocations a JOIN public.ordres_fabrication o ON o.id=a.source_of_id
      WHERE a.consolidation_id=NEW.consolidation_id AND a.state='ACTIVE' AND o.client_id IS DISTINCT FROM producer.client_id) THEN
    RAISE EXCEPTION 'Recovery grouping identity, quantity or protected deadline changed' USING ERRCODE='23514';
  END IF;
  IF EXISTS(SELECT 1 FROM public.of_operations op WHERE op.of_id IN(NEW.producer_of_id,NEW.recovery_of_id)
    AND (op.revision_id IS NULL OR EXISTS(SELECT 1 FROM public.of_revisions v WHERE v.id=op.revision_id AND v.statut='ACTIVE'))
    AND ((op.of_id=NEW.recovery_of_id AND (op.status::text NOT IN('TODO','READY') OR op.started_at IS NOT NULL OR op.ended_at IS NOT NULL))
      OR (op.of_id=NEW.producer_of_id AND (op.status::text='DONE' OR op.ended_at IS NOT NULL)
        AND EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(producer.technical_snapshot->'operations','[]'::jsonb)) frozen
          WHERE frozen->>'phase'=op.phase::text AND frozen->>'type_operation'='DECOUPE'))))
    OR EXISTS(SELECT 1 FROM public.planning_events WHERE of_id=NEW.recovery_of_id AND archived_at IS NULL AND status<>'CANCELLED') THEN
    RAISE EXCEPTION 'Recovery is engaged or producer cutting has already finished' USING ERRCODE='23514';
  END IF;
  SELECT count(*) INTO closed_count FROM public.of_operations op WHERE op.of_id=NEW.producer_of_id
    AND (op.revision_id IS NULL OR EXISTS(SELECT 1 FROM public.of_revisions v WHERE v.id=op.revision_id AND v.statut='ACTIVE'))
    AND (op.status::text='DONE' OR op.ended_at IS NOT NULL);
  IF jsonb_typeof(COALESCE(NEW.evidence->'resumptions','[]'))<>'array'
    OR closed_count<>jsonb_array_length(COALESCE(NEW.evidence->'resumptions','[]'))
    OR closed_count<>(SELECT count(DISTINCT r->>'operation_id') FROM jsonb_array_elements(COALESCE(NEW.evidence->'resumptions','[]')) r) THEN
    RAISE EXCEPTION 'Every completed operation requires exactly one preserved cycle before resumption' USING ERRCODE='23514';
  END IF;
  FOR resumed IN SELECT * FROM jsonb_array_elements(COALESCE(NEW.evidence->'resumptions','[]')) LOOP
    SELECT to_jsonb(op) INTO prior FROM public.of_operations op WHERE op.id=(resumed->>'operation_id')::uuid
      AND op.of_id=NEW.producer_of_id AND (op.revision_id IS NULL OR EXISTS(SELECT 1 FROM public.of_revisions v WHERE v.id=op.revision_id AND v.statut='ACTIVE')) FOR UPDATE;
    SELECT COALESCE(jsonb_agg(to_jsonb(e) ORDER BY e.id),'[]') INTO saved_events FROM public.planning_events e
      WHERE e.of_operation_id=(resumed->>'operation_id')::uuid AND e.archived_at IS NULL AND e.status<>'CANCELLED';
    SELECT to_jsonb(t) INTO saved_task FROM public.planning_tasks t WHERE t.id=resumed->>'task_id' AND t.operation_id=(resumed->>'operation_id')::uuid;
    IF prior IS NULL OR prior IS DISTINCT FROM resumed->'before' OR prior->>'status' IS DISTINCT FROM 'DONE'
      OR prior->>'ended_at' IS NULL OR (prior->>'ended_at')::timestamptz>clock_timestamp()
      OR saved_events IS DISTINCT FROM resumed->'planning_events' OR COALESCE(saved_task,'null'::jsonb) IS DISTINCT FROM resumed->'planning_task'
      OR EXISTS(SELECT 1 FROM public.production_pointages p WHERE p.operation_id=(resumed->>'operation_id')::uuid AND p.status='RUNNING')
      OR EXISTS(SELECT 1 FROM public.of_time_logs l WHERE l.of_operation_id=(resumed->>'operation_id')::uuid AND l.ended_at IS NULL) THEN
      RAISE EXCEPTION 'Completed operation history changed or an operator is still clocked in' USING ERRCODE='23514';
    END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM public.of_operations op WHERE op.of_id=NEW.producer_of_id
      AND (op.revision_id IS NULL OR EXISTS(SELECT 1 FROM public.of_revisions v WHERE v.id=op.revision_id AND v.statut='ACTIVE'))
      AND (op.status::text='RUNNING' OR op.started_at IS NOT NULL))
    AND NOT EXISTS(SELECT 1 FROM public.of_operations op,
      LATERAL jsonb_array_elements(COALESCE(producer.technical_snapshot->'operations','[]'::jsonb)) frozen
      WHERE op.of_id=NEW.producer_of_id AND frozen->>'phase'=op.phase::text AND frozen->>'type_operation'='DECOUPE'
      AND (op.revision_id IS NULL OR EXISTS(SELECT 1 FROM public.of_revisions v WHERE v.id=op.revision_id AND v.statut='ACTIVE'))) THEN
    RAISE EXCEPTION 'An engaged producer requires an identifiable unfinished cutting operation' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER recovery_consolidation_addition_identity BEFORE INSERT ON public.production_recovery_consolidation_additions
  FOR EACH ROW EXECUTE FUNCTION public.fn_recovery_consolidation_addition_1034();

CREATE OR REPLACE FUNCTION public.fn_guard_consolidation_producer_712() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.quantite_lancee IS DISTINCT FROM OLD.quantite_lancee
    AND EXISTS(SELECT 1 FROM public.production_consolidations WHERE producer_of_id=NEW.id AND state='ACTIVE')
    AND NOT EXISTS(SELECT 1 FROM public.production_recovery_consolidation_additions proof
      JOIN public.production_consolidations grouping ON grouping.id=proof.consolidation_id
      WHERE proof.producer_of_id=NEW.id AND grouping.state='ACTIVE' AND proof.created_xid=pg_current_xact_id()
        AND proof.previous_quantity=OLD.quantite_lancee AND proof.new_quantity=NEW.quantite_lancee) THEN
    RAISE EXCEPTION 'CONSOLIDATION_QUANTITY_LOCKED: utiliser un ajout de récupération validé' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION public.fn_recovery_consolidation_addition_complete_1034() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE producer record; source record; allocation record; validation record; operation jsonb; preparation jsonb; slot record; actual_count integer;
  resumed jsonb; current_operation jsonb; old_event jsonb; current_event jsonb;
BEGIN
  SELECT * INTO producer FROM public.ordres_fabrication WHERE id=NEW.producer_of_id;
  SELECT * INTO source FROM public.ordres_fabrication WHERE id=NEW.recovery_of_id;
  SELECT * INTO allocation FROM public.production_consolidation_allocations WHERE id=NEW.allocation_id;
  SELECT * INTO validation FROM public.of_dossier_validations WHERE id=NEW.dossier_validation_id;
  IF producer.quantite_lancee IS DISTINCT FROM NEW.new_quantity OR source.quantite_lancee IS DISTINCT FROM NEW.additional_quantity
    OR producer.technical_snapshot_sha256 IS DISTINCT FROM NEW.technical_hash
    OR allocation.consolidation_id IS DISTINCT FROM NEW.consolidation_id OR allocation.source_of_id IS DISTINCT FROM NEW.recovery_of_id
    OR allocation.quantity IS DISTINCT FROM NEW.additional_quantity OR allocation.state IS DISTINCT FROM 'ACTIVE'
    OR validation.of_id IS DISTINCT FROM NEW.producer_of_id OR validation.invalidated_at IS NOT NULL
    OR validation.evidence->>'recovery_consolidation_addition_id' IS DISTINCT FROM NEW.id::text THEN
    RAISE EXCEPTION 'Recovery addition requires its exact allocation and refreshed dossier in the same transaction' USING ERRCODE='23514';
  END IF;
  IF jsonb_typeof(NEW.evidence->'operations') IS DISTINCT FROM 'array' OR jsonb_array_length(NEW.evidence->'operations')=0 THEN
    RAISE EXCEPTION 'Recovery addition requires all committed operation slots' USING ERRCODE='23514';
  END IF;
  SELECT count(*) INTO actual_count FROM public.of_operations op WHERE op.of_id=NEW.producer_of_id
    AND (op.revision_id IS NULL OR EXISTS(SELECT 1 FROM public.of_revisions v WHERE v.id=op.revision_id AND v.statut='ACTIVE'));
  IF actual_count<>jsonb_array_length(NEW.evidence->'operations') OR actual_count<>(SELECT count(DISTINCT value->>'operation_id') FROM jsonb_array_elements(NEW.evidence->'operations')) THEN
    RAISE EXCEPTION 'Every producer operation must be present exactly once' USING ERRCODE='23514';
  END IF;
  IF NEW.proposed_finish IS DISTINCT FROM (SELECT max((value->>'end')::timestamptz) FROM jsonb_array_elements(NEW.evidence->'operations')) THEN
    RAISE EXCEPTION 'Recovery finish must match its last reviewed operation' USING ERRCODE='23514';
  END IF;
  FOR resumed IN SELECT * FROM jsonb_array_elements(COALESCE(NEW.evidence->'resumptions','[]')) LOOP
    SELECT to_jsonb(op) INTO current_operation FROM public.of_operations op WHERE op.id=(resumed->>'operation_id')::uuid;
    IF current_operation->>'status' IS DISTINCT FROM 'READY' OR current_operation->>'started_at' IS NOT NULL OR current_operation->>'ended_at' IS NOT NULL
      OR (current_operation-ARRAY['status','started_at','ended_at','updated_at','machine_id','poste_id'])
        IS DISTINCT FROM ((resumed->'before')-ARRAY['status','started_at','ended_at','updated_at','machine_id','poste_id'])
      OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.evidence->'operations') proposed
        WHERE proposed->>'operation_id'=resumed->>'operation_id' AND (proposed->>'start')::timestamptz>=NEW.created_at) THEN
      RAISE EXCEPTION 'Resumption must preserve the operation and counters with a new future commitment' USING ERRCODE='23514';
    END IF;
    FOR old_event IN SELECT * FROM jsonb_array_elements(resumed->'planning_events') LOOP
      SELECT to_jsonb(e) INTO current_event FROM public.planning_events e WHERE e.id=(old_event->>'id')::uuid;
      IF current_event IS NULL OR current_event->>'archived_at' IS NULL
        OR current_event-ARRAY['archived_at','archived_by','updated_at','updated_by']
          IS DISTINCT FROM old_event-ARRAY['archived_at','archived_by','updated_at','updated_by'] THEN
        RAISE EXCEPTION 'The completed planning slot must be archived without rewriting its history' USING ERRCODE='23514';
      END IF;
    END LOOP;
  END LOOP;
  FOR operation IN SELECT * FROM jsonb_array_elements(NEW.evidence->'operations') LOOP
    IF (operation->>'end')::timestamptz>=NEW.finish_before OR (operation->>'end')::timestamptz<=(operation->>'start')::timestamptz THEN
      RAISE EXCEPTION 'Every reviewed operation must finish before the protected deadline' USING ERRCODE='23514';
    END IF;
    IF COALESCE((operation->>'external')::boolean,false) THEN
      SELECT count(*) AS count,min(t.committed_start) AS start_at,max(t.committed_end) AS end_at INTO slot
        FROM public.planning_tasks t JOIN public.of_operations op ON op.id=t.operation_id
        WHERE op.id=(operation->>'operation_id')::uuid AND op.of_id=NEW.producer_of_id
          AND EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(producer.technical_snapshot->'operations','[]'::jsonb)) frozen
            WHERE frozen->>'phase'=op.phase::text AND frozen->>'type_operation'='SOUS_TRAITANCE');
      IF slot.count<>1 OR slot.start_at IS DISTINCT FROM (operation->>'start')::timestamptz
        OR slot.end_at IS DISTINCT FROM (operation->>'end')::timestamptz
        OR EXISTS(SELECT 1 FROM public.planning_events WHERE of_operation_id=(operation->>'operation_id')::uuid AND archived_at IS NULL AND status<>'CANCELLED')
        OR jsonb_typeof(operation->'preparations') IS DISTINCT FROM 'array' OR jsonb_array_length(operation->'preparations')=0 THEN
        RAISE EXCEPTION 'External recovery operation requires its canonical commitment and supplier preparations' USING ERRCODE='23514';
      END IF;
      IF jsonb_array_length(operation->'preparations')<>(SELECT count(DISTINCT p->>'purchaseId') FROM jsonb_array_elements(operation->'preparations') p) THEN
        RAISE EXCEPTION 'A supplier preparation must cover one distinct service' USING ERRCODE='23514';
      END IF;
      FOR preparation IN SELECT * FROM jsonb_array_elements(operation->'preparations') LOOP
        IF (preparation->>'quantity')::numeric IS DISTINCT FROM NEW.new_quantity OR NOT EXISTS(
          SELECT 1 FROM public.production_purchase_preparations prep WHERE prep.id=(preparation->>'id')::uuid
            AND prep.of_id=NEW.producer_of_id AND prep.kind='PRESTATION' AND prep.status<>'PERIMEE'
            AND prep.source_ref::text=preparation->>'purchaseId' AND prep.supplier_id::text=preparation->>'supplierId'
            AND prep.technical_hash=NEW.technical_hash AND prep.technical_version_id=producer.piece_technique_version_id
            AND prep.of_revision_id IS NOT DISTINCT FROM (SELECT r.id FROM public.of_revisions r WHERE r.of_id=NEW.producer_of_id AND r.statut='ACTIVE')
            AND prep.snapshot->'service'->'selection'->>'operationId'=operation->>'operation_id'
            AND prep.snapshot->'service'->'selection'->>'catalogueId'=preparation->>'catalogueId'
            AND (prep.snapshot->'service'->>'forecastQuantity')::numeric=NEW.new_quantity) THEN
          RAISE EXCEPTION 'External recovery supplement was not saved for the exact reviewed quantity and supplier' USING ERRCODE='23514';
        END IF;
      END LOOP;
      CONTINUE;
    END IF;
    SELECT count(*) AS count,min(e.start_ts) AS start_at,max(e.end_ts) AS end_at,
      min(COALESCE('machine:'||e.machine_id::text,'poste:'||e.poste_id::text)) AS resource
      INTO slot FROM public.planning_events e JOIN public.of_operations op ON op.id=e.of_operation_id
      WHERE op.id=(operation->>'operation_id')::uuid AND op.of_id=NEW.producer_of_id AND e.archived_at IS NULL AND e.status<>'CANCELLED';
    IF slot.count<>1 OR slot.start_at IS DISTINCT FROM (operation->>'start')::timestamptz
      OR slot.end_at IS DISTINCT FROM (operation->>'end')::timestamptz OR slot.resource IS DISTINCT FROM operation->>'resource_id'
      OR slot.end_at>=NEW.finish_before OR slot.end_at<=slot.start_at THEN
      RAISE EXCEPTION 'Recovery addition must commit the reviewed capacity before every protected delivery date' USING ERRCODE='23514';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER recovery_consolidation_addition_complete AFTER INSERT ON public.production_recovery_consolidation_additions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.fn_recovery_consolidation_addition_complete_1034();
REVOKE ALL ON public.production_recovery_consolidation_additions FROM PUBLIC,cerp_app;
GRANT SELECT,INSERT ON public.production_recovery_consolidation_additions TO cerp_app;
REVOKE ALL ON FUNCTION public.fn_recovery_consolidation_addition_1034(),public.fn_recovery_consolidation_addition_complete_1034() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_recovery_consolidation_addition_1034(),public.fn_recovery_consolidation_addition_complete_1034() TO cerp_app;
COMMIT;
