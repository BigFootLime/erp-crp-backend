-- #767 / frontend #1028: preparation completion is not a production status.
BEGIN;
DO $$ BEGIN
  IF to_regclass('public.planning_central_settings') IS NULL OR to_regclass('public.of_preparation_evaluations') IS NULL THEN
    RAISE EXCEPTION 'Dossier completion requires planning and preparation';
  END IF;
END $$;
INSERT INTO public.app_feature_flags(key,name,description,enabled,environment)
VALUES('PRODUCTION_MATERIAL_WORKFLOW','Dossier Complet et parcours matière','Validation du dossier après planning puis couverture matière par opération.',false,'all')
ON CONFLICT(key) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.of_dossier_validations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  of_id bigint NOT NULL REFERENCES public.ordres_fabrication(id) ON DELETE RESTRICT,
  source_hash text NOT NULL CHECK(source_hash ~ '^[a-f0-9]{64}$'),
  planning_revision bigint NOT NULL,
  evidence jsonb NOT NULL,
  decided_by integer NOT NULL REFERENCES public.users(id),
  decided_at timestamptz NOT NULL DEFAULT now(),
  invalidated_at timestamptz,
  invalidation_reason text,
  CHECK((invalidated_at IS NULL) = (invalidation_reason IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS of_dossier_one_active_idx ON public.of_dossier_validations(of_id) WHERE invalidated_at IS NULL;
CREATE INDEX IF NOT EXISTS of_dossier_history_idx ON public.of_dossier_validations(of_id,decided_at DESC);
CREATE TABLE IF NOT EXISTS public.of_material_commands (
  idempotency_key uuid PRIMARY KEY,
  actor_id integer NOT NULL REFERENCES public.users(id),
  of_id bigint NOT NULL REFERENCES public.ordres_fabrication(id) ON DELETE RESTRICT,
  command_type text NOT NULL,
  payload_hash text NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.of_dossier_invalidate() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target bigint; reason text;
BEGIN
  IF TG_TABLE_NAME='ordres_fabrication' THEN
    target := NEW.id; reason := 'La quantité ou la définition technique a changé.';
  ELSIF TG_TABLE_NAME='of_operations' THEN
    IF TG_OP='DELETE' THEN target:=OLD.of_id; ELSE target:=NEW.of_id; END IF;
    reason := 'La gamme de fabrication a changé.';
  ELSE
    IF TG_OP='DELETE' THEN target:=OLD.of_id; ELSE target:=NEW.of_id; END IF;
    -- Deferred evaluation sees the final transaction: a move that replaces a
    -- slot with another valid slot must not invalidate the technical dossier.
    IF NOT EXISTS(SELECT 1 FROM public.of_operations p WHERE p.of_id=target
      AND (p.revision_id IS NULL OR EXISTS(SELECT 1 FROM public.of_revisions r WHERE r.id=p.revision_id AND r.statut='ACTIVE'))
      AND p.status NOT IN ('RUNNING','DONE') AND NOT EXISTS(
        SELECT 1 FROM public.planning_events e WHERE e.of_operation_id=p.id
          AND e.archived_at IS NULL AND e.status<>'CANCELLED' AND e.end_ts>e.start_ts
          AND (e.machine_id IS NOT NULL OR e.poste_id IS NOT NULL))) THEN
      RETURN NULL;
    END IF;
    reason := 'Une opération a été retirée du planning engagé.';
  END IF;
  UPDATE public.of_dossier_validations SET invalidated_at=clock_timestamp(),invalidation_reason=reason
    WHERE of_id=target AND invalidated_at IS NULL;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS of_dossier_definition_changed ON public.ordres_fabrication;
CREATE TRIGGER of_dossier_definition_changed AFTER UPDATE ON public.ordres_fabrication FOR EACH ROW
WHEN(OLD.quantite_lancee IS DISTINCT FROM NEW.quantite_lancee OR OLD.piece_technique_version_id IS DISTINCT FROM NEW.piece_technique_version_id
 OR OLD.technical_snapshot_sha256 IS DISTINCT FROM NEW.technical_snapshot_sha256 OR OLD.technical_readiness IS DISTINCT FROM NEW.technical_readiness)
EXECUTE FUNCTION public.of_dossier_invalidate();
DROP TRIGGER IF EXISTS of_dossier_operations_changed ON public.of_operations;
CREATE TRIGGER of_dossier_operations_changed AFTER INSERT OR DELETE ON public.of_operations FOR EACH ROW EXECUTE FUNCTION public.of_dossier_invalidate();
DROP TRIGGER IF EXISTS of_dossier_operation_changed ON public.of_operations;
CREATE TRIGGER of_dossier_operation_changed AFTER UPDATE ON public.of_operations FOR EACH ROW
WHEN(ROW(OLD.phase,OLD.designation,OLD.tp,OLD.tf_unit,OLD.qte,OLD.coef,OLD.revision_id)
 IS DISTINCT FROM ROW(NEW.phase,NEW.designation,NEW.tp,NEW.tf_unit,NEW.qte,NEW.coef,NEW.revision_id))
EXECUTE FUNCTION public.of_dossier_invalidate();
DROP TRIGGER IF EXISTS of_dossier_planning_changed ON public.planning_events;
CREATE CONSTRAINT TRIGGER of_dossier_planning_changed AFTER INSERT OR UPDATE OR DELETE ON public.planning_events
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.of_dossier_invalidate();

-- Match application roles already entitled to the OF and planning registries.
DO $$ DECLARE app_role text; BEGIN
  FOR app_role IN SELECT DISTINCT grantee FROM information_schema.role_table_grants
    WHERE table_schema='public' AND table_name='ordres_fabrication' AND privilege_type='UPDATE' AND grantee NOT IN ('PUBLIC','postgres')
  LOOP
    EXECUTE format('GRANT SELECT,INSERT,UPDATE ON public.of_dossier_validations TO %I',app_role);
    EXECUTE format('GRANT SELECT,INSERT ON public.of_material_commands TO %I',app_role);
  END LOOP;
END $$;
ALTER TABLE public.of_dossier_validations OWNER TO cerp_app;
ALTER TABLE public.of_material_commands OWNER TO cerp_app;
COMMIT;
