-- Rollback — 20260729_of_versioning_replanification_ar_370.sql
--
-- DESTRUCTIF. Supprime les révisions d'OF, les VISA, les propositions de dérive,
-- les versions de planning, les dossiers d'AR à recaler et les documents d'OF figés.
--
-- N'exécuter qu'après sauvegarde et autorisation humaine explicite, et seulement si
-- ces objets n'ont pas encore reçu de données métier à conserver. Le contrôle
-- ci-dessous refuse la suppression tant que des lignes existent : le lever est une
-- décision, pas une formalité.

BEGIN;

DO $$
DECLARE
  v_rows bigint := 0;
  v_force boolean := coalesce(current_setting('cerp.rollback_force', true) = 'on', false);
BEGIN
  SELECT
    (SELECT count(*) FROM public.of_revisions WHERE snapshot->>'origin' IS DISTINCT FROM 'BACKFILL')
    + (SELECT count(*) FROM public.of_operation_visas)
    + (SELECT count(*) FROM public.of_time_variance_proposals)
    + (SELECT count(*) FROM public.of_planning_versions)
    + (SELECT count(*) FROM public.ar_recalage_dossiers)
    + (SELECT count(*) FROM public.of_documents)
  INTO v_rows;

  IF v_rows > 0 AND NOT v_force THEN
    RAISE EXCEPTION
      'Rollback refusé : % ligne(s) métier seraient perdues. Relancer avec SET cerp.rollback_force = ''on'' pour assumer la perte.',
      v_rows;
  END IF;
END $$;

-- Les triggers d'immuabilité interdisent DROP/DELETE ligne à ligne ; on retire les
-- triggers avant de retirer les tables qui les portent.
DROP TRIGGER IF EXISTS trg_of_documents_immutable ON public.of_documents;
DROP TRIGGER IF EXISTS trg_of_operation_visas_append_only ON public.of_operation_visas;
DROP TRIGGER IF EXISTS trg_of_operations_obsolete_revision_readonly ON public.of_operations;
DROP TRIGGER IF EXISTS trg_of_revisions_immutable ON public.of_revisions;

DROP FUNCTION IF EXISTS public.fn_of_documents_immutable();
DROP FUNCTION IF EXISTS public.fn_of_operation_visas_append_only();
DROP FUNCTION IF EXISTS public.fn_of_operations_obsolete_revision_readonly();
DROP FUNCTION IF EXISTS public.fn_of_revisions_immutable();

DROP TABLE IF EXISTS public.of_documents;
DROP TABLE IF EXISTS public.ar_recalage_dossiers;
DROP TABLE IF EXISTS public.of_planning_versions;
DROP TABLE IF EXISTS public.of_time_variance_proposals;
DROP TABLE IF EXISTS public.of_operation_visas;
DROP TABLE IF EXISTS public.notification_routing;

-- Rétablir la clé d'unicité historique avant de retirer `revision_id`.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'of_operations_of_revision_phase_key'
      AND conrelid = 'public.of_operations'::regclass
  ) THEN
    ALTER TABLE public.of_operations DROP CONSTRAINT of_operations_of_revision_phase_key;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'of_operations_of_id_phase_key'
      AND conrelid = 'public.of_operations'::regclass
  ) THEN
    ALTER TABLE public.of_operations
      ADD CONSTRAINT of_operations_of_id_phase_key UNIQUE (of_id, phase);
  END IF;
END $$;

ALTER TABLE public.of_operations DROP COLUMN IF EXISTS revision_id;

DROP TABLE IF EXISTS public.of_revisions;

COMMIT;
