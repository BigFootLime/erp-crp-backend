-- #461 — Publication guidée d'une version technique.
--
-- Les versions APPLICABLE restent immuables. La seule nouvelle exception est
-- une accélération explicite d'une date d'effet encore future vers aujourd'hui
-- (ou NULL, qui signifie effet immédiat dans le moteur OF). Aucun contenu
-- technique, statut ou instantané documentaire ne peut être modifié par cette
-- exception. L'action HTTP correspondante est protégée par RBAC et auditée.
--
-- Le gel documentaire des nouvelles publications est désormais réalisé AVANT
-- la promotion par le repository ; il n'a donc besoin d'aucune exception ici.
-- Patch idempotent : CREATE OR REPLACE conserve le trigger existant.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.piece_technique_versions') IS NULL THEN
    RAISE EXCEPTION 'Pré-requis absent: public.piece_technique_versions';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.fn_prevent_validated_piece_version_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.statut IN ('APPLICABLE', 'OBSOLETE') THEN
    RAISE EXCEPTION 'Validated technical versions are retained for traceability'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.statut IN ('APPLICABLE', 'OBSOLETE') THEN
    -- Déclassement historique déjà autorisé : seule la mécanique de statut
    -- change, le contenu technique reste identique.
    IF OLD.statut = 'APPLICABLE'
       AND NEW.statut = 'OBSOLETE'
       AND (to_jsonb(NEW) - ARRAY['statut', 'is_current', 'updated_at', 'updated_by'])
           IS NOT DISTINCT FROM (to_jsonb(OLD) - ARRAY['statut', 'is_current', 'updated_at', 'updated_by']) THEN
      RETURN NEW;
    END IF;

    -- Une version planifiée dans le futur peut être avancée à effet immédiat.
    -- L'exception est volontairement à sens unique : impossible de reporter
    -- une version déjà effective ou de toucher à un autre champ validé.
    IF OLD.statut = 'APPLICABLE'
       AND NEW.statut = 'APPLICABLE'
       AND OLD.date_effet IS NOT NULL
       AND OLD.date_effet > CURRENT_DATE
       AND (NEW.date_effet IS NULL OR NEW.date_effet <= CURRENT_DATE)
       AND NEW.updated_by IS NOT NULL
       AND (to_jsonb(NEW) - ARRAY['date_effet', 'updated_at', 'updated_by'])
           IS NOT DISTINCT FROM (to_jsonb(OLD) - ARRAY['date_effet', 'updated_at', 'updated_by']) THEN
      RETURN NEW;
    END IF;

    RAISE EXCEPTION 'Validated technical versions are immutable; create a new version instead'
      USING ERRCODE = '55000';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

COMMENT ON FUNCTION public.fn_prevent_validated_piece_version_mutation() IS
  '#461 — protège les versions validées ; autorise seulement déclassement et avance contrôlée d’une date d’effet future.';

COMMIT;
