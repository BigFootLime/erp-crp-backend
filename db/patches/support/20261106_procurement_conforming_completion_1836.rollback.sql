-- #1836: restore the previous guard only; keep all immutable completion records.
BEGIN;
SET LOCAL lock_timeout='5s';
DO $preflight$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname='guard_subcontract_completion_1273'
      AND p.pronargs=0 AND md5(replace(p.prosrc,E'\r','')) IN('9b88692c6c10b9efc322301adba2bf91','28cdd52fec5aae7cd2297cc4ed5373f6')) THEN
    RAISE EXCEPTION 'SUBCONTRACT_COMPLETION_GUARD_DRIFT' USING ERRCODE='55000';
  END IF;
END $preflight$;
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
COMMIT;
