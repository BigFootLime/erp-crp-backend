-- Rollback #461 — restaure la politique d'immuabilité stricte du patch
-- 20260713. Aucun enregistrement métier n'est supprimé ou réécrit.
--
-- Après rollback, une version APPLICABLE à date d'effet future devra être
-- remplacée par un nouvel indice pour devenir immédiatement effective.

BEGIN;

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
    IF OLD.statut = 'APPLICABLE'
       AND NEW.statut = 'OBSOLETE'
       AND (to_jsonb(NEW) - ARRAY['statut', 'is_current', 'updated_at', 'updated_by'])
           IS NOT DISTINCT FROM (to_jsonb(OLD) - ARRAY['statut', 'is_current', 'updated_at', 'updated_by']) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Validated technical versions are immutable; create a new version instead'
      USING ERRCODE = '55000';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

COMMENT ON FUNCTION public.fn_prevent_validated_piece_version_mutation() IS NULL;

COMMIT;
