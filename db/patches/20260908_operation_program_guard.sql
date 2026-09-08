-- #767: keep the SQL backstop aligned with the operation-level programme gate.
BEGIN;
CREATE OR REPLACE FUNCTION public.fn_guard_preparation_execution_712() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target bigint; o public.ordres_fabrication; execution boolean:=false; task uuid; operation uuid; operation_kind text;
BEGIN
  IF TG_TABLE_NAME='ordres_fabrication' THEN
    IF NEW.statut IS NOT DISTINCT FROM OLD.statut OR NEW.statut IN ('BROUILLON','ANNULE') THEN RETURN NEW; END IF;
    target:=NEW.id; execution:=NEW.statut='EN_COURS';
    SELECT p.operation_id INTO operation FROM public.production_pointages p WHERE p.of_id=target AND p.status='RUNNING' ORDER BY p.created_at DESC,p.id DESC LIMIT 1;
  ELSIF TG_TABLE_NAME='planning_events' THEN
    IF NEW.archived_at IS NOT NULL OR NEW.status='CANCELLED' THEN RETURN NEW; END IF;
    target:=COALESCE((SELECT of_id FROM public.of_operations WHERE id=NEW.of_operation_id),NEW.of_id);
  ELSIF TG_TABLE_NAME='of_operations' THEN
    IF NEW.status::text IN ('TODO','READY','CANCELLED') OR (TG_OP='UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status) THEN RETURN NEW; END IF;
    target:=NEW.of_id; operation:=NEW.id; execution:=true;
  ELSIF TG_TABLE_NAME='of_time_logs' THEN
    target:=(SELECT of_id FROM public.of_operations WHERE id=NEW.of_operation_id); operation:=NEW.of_operation_id; execution:=true;
  ELSE target:=NEW.of_id; operation:=NEW.operation_id; execution:=true;
  END IF;
  SELECT * INTO o FROM public.ordres_fabrication WHERE id=target FOR UPDATE;
  IF o.preparation_rules_version IS NULL THEN RETURN NEW; END IF;
  IF o.technical_readiness<>'VALIDATED' OR o.technical_snapshot_sha256 IS NULL
     OR NOT EXISTS(SELECT 1 FROM public.of_self_inspection_sheets s WHERE s.id=NULLIF(o.technical_preparation->>'self_inspection_sheet_id','')::uuid AND s.of_id=o.id AND s.state='READY' AND (s.snapshot->'of'->>'quantite_lancee')::numeric=o.quantite_lancee) THEN
    RAISE EXCEPTION 'OF_PREPARATION_REQUIRED: terminer et valider le dossier de préparation' USING ERRCODE='23514';
  END IF;
  task:=NULLIF(o.technical_snapshot->'preparation_decisions'->'programming'->>'task_id','')::uuid;
  -- The programme is an operation prerequisite. A cutting/control operation
  -- may start while the machining programme remains pending. Resolve only from
  -- the frozen route and an active dossier proof; unknown/foreign operations
  -- retain the conservative legacy gate.
  IF execution AND EXISTS(SELECT 1 FROM public.of_dossier_validations v WHERE v.of_id=target AND v.invalidated_at IS NULL) THEN
    SELECT f.value->>'type_operation' INTO operation_kind
    FROM public.of_operations op CROSS JOIN LATERAL jsonb_array_elements(COALESCE(o.technical_snapshot->'operations','[]')) f
    WHERE op.id=operation AND op.of_id=target AND f.value->>'phase'=op.phase::text
      AND (op.revision_id IS NULL OR EXISTS(SELECT 1 FROM public.of_revisions r WHERE r.id=op.revision_id AND r.statut='ACTIVE'))
    LIMIT 1;
    IF operation_kind IN ('DECOUPE','CONTROLE','ASSEMBLAGE','FINITION','TRAITEMENT','SOUS_TRAITANCE','AUTRE') THEN execution:=false; END IF;
  END IF;
  IF execution AND task IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.piece_version_programming_tasks WHERE id=task AND status='DONE') THEN
    RAISE EXCEPTION 'OF_PROGRAMMING_REQUIRED: terminer la programmation avant démarrage' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
COMMIT;
