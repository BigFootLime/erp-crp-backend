-- Rollback 20260728_surface_finish_library_210.
--
-- ⚠️ RÉALISTE, PAS MAGIQUE. Ce script annule la STRUCTURE ajoutée par le patch.
-- Il DÉTRUIT les données saisies dans la bibliothèque de finitions et les
-- exigences posées sur les gammes. Il ne restaure rien : la seule reprise
-- possible après usage réel est une restauration de sauvegarde.
--
-- Conditions d'exécution acceptables :
--   1. le patch vient d'être appliqué et AUCUNE finition n'a été saisie ;
--   2. ou une sauvegarde vérifiée existe et la perte est assumée par écrit.
--
-- Le garde-fou ci-dessous refuse le rollback si des données métier existent.
-- Pour passer outre en connaissance de cause : SET cerp.force_rollback = 'on';

BEGIN;

DO $$
DECLARE
  v_finishes    bigint := 0;
  v_links       bigint := 0;
  v_articles    bigint := 0;
  v_achats      bigint := 0;
  v_force       text   := current_setting('cerp.force_rollback', true);
BEGIN
  IF to_regclass('public.surface_finishes') IS NOT NULL THEN
    EXECUTE 'SELECT COUNT(*) FROM public.surface_finishes' INTO v_finishes;
  END IF;
  IF to_regclass('public.gamme_operation_finitions') IS NOT NULL THEN
    EXECUTE 'SELECT COUNT(*) FROM public.gamme_operation_finitions' INTO v_links;
  END IF;
  IF to_regclass('public.articles_traitement') IS NOT NULL THEN
    EXECUTE 'SELECT COUNT(*) FROM public.articles_traitement WHERE spec_fingerprint IS NOT NULL' INTO v_articles;
  END IF;
  IF to_regclass('public.pieces_techniques_achats') IS NOT NULL THEN
    EXECUTE 'SELECT COUNT(*) FROM public.pieces_techniques_achats WHERE gamme_operation_id IS NOT NULL' INTO v_achats;
  END IF;

  IF (v_finishes + v_links + v_articles + v_achats) > 0 AND COALESCE(v_force, 'off') <> 'on' THEN
    RAISE EXCEPTION
      'Rollback refusé : % finition(s), % exigence(s), % article(s) tracé(s), % ligne(s) d''achat liée(s). Restaurez une sauvegarde ou posez SET cerp.force_rollback = ''on''.',
      v_finishes, v_links, v_articles, v_achats
      USING ERRCODE = '2F000';
  END IF;
END $$;

-- 1) Liaisons ajoutées à la nomenclature d'achat (les lignes elles-mêmes restent).
DROP INDEX IF EXISTS public.pt_achats_gamme_operation_traitement_uq;
DROP INDEX IF EXISTS public.pt_achats_gamme_idx;
ALTER TABLE public.pieces_techniques_achats
  DROP CONSTRAINT IF EXISTS pt_achats_gamme_operation_fk,
  DROP CONSTRAINT IF EXISTS pt_achats_gamme_fk,
  DROP CONSTRAINT IF EXISTS pt_achats_version_fk,
  DROP CONSTRAINT IF EXISTS pt_achats_source_check;
ALTER TABLE public.pieces_techniques_achats
  DROP COLUMN IF EXISTS gamme_operation_id,
  DROP COLUMN IF EXISTS gamme_id,
  DROP COLUMN IF EXISTS piece_technique_version_id,
  DROP COLUMN IF EXISTS designation_snapshot,
  DROP COLUMN IF EXISTS source;

-- 2) Extension de la spécialisation article (les articles eux-mêmes restent).
DROP INDEX IF EXISTS public.articles_traitement_fingerprint_current_uq;
DROP INDEX IF EXISTS public.articles_traitement_version_idx;
DROP INDEX IF EXISTS public.articles_traitement_revision_idx;
ALTER TABLE public.articles_traitement
  DROP CONSTRAINT IF EXISTS articles_traitement_piece_fk,
  DROP CONSTRAINT IF EXISTS articles_traitement_version_fk,
  DROP CONSTRAINT IF EXISTS articles_traitement_finish_revision_fk,
  DROP CONSTRAINT IF EXISTS articles_traitement_origin_check,
  DROP CONSTRAINT IF EXISTS articles_traitement_fingerprint_format,
  DROP CONSTRAINT IF EXISTS articles_traitement_spec_pair_check;
ALTER TABLE public.articles_traitement
  DROP COLUMN IF EXISTS piece_technique_id,
  DROP COLUMN IF EXISTS piece_technique_version_id,
  DROP COLUMN IF EXISTS finish_revision_id,
  DROP COLUMN IF EXISTS spec_fingerprint,
  DROP COLUMN IF EXISTS spec_canonical,
  DROP COLUMN IF EXISTS generated_designation,
  DROP COLUMN IF EXISTS generated_comment,
  DROP COLUMN IF EXISTS template_version,
  DROP COLUMN IF EXISTS origin,
  DROP COLUMN IF EXISTS superseded_at;
-- `created_by` est laissé en place : d'autres chantiers pourraient l'avoir posé.

-- 3) Tables du chantier (ordre inverse des dépendances).
DROP TABLE IF EXISTS public.surface_finish_command_receipts;
DROP TABLE IF EXISTS public.gamme_operation_finitions;
DROP TABLE IF EXISTS public.surface_finish_revision_documents;
ALTER TABLE IF EXISTS public.surface_finishes
  DROP CONSTRAINT IF EXISTS surface_finishes_current_revision_fk;
DROP TABLE IF EXISTS public.surface_finish_revisions;

DROP TRIGGER IF EXISTS trg_surface_finish_code_immutable ON public.surface_finishes;
DROP TABLE IF EXISTS public.surface_finishes;
DROP TABLE IF EXISTS public.surface_finish_families;
DROP FUNCTION IF EXISTS public.fn_protect_surface_finish_code_210();
DROP FUNCTION IF EXISTS public.surface_finish_norm(text);
DROP FUNCTION IF EXISTS public.surface_finish_to_um(numeric, text);

-- 4) Codification : on RESTAURE le whitelist de 20260726_metrologie_360_229.
--    Retirer `FIN` sans restaurer le reste casserait machines et métrologie.
CREATE OR REPLACE FUNCTION public.fn_next_issued_code_value(p_scope text)
RETURNS bigint
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
  v_scope text := upper(btrim(COALESCE(p_scope, '')));
BEGIN
  IF v_scope !~ '^(CLI|FOU|MCH|MET|ART:[A-Z0-9]{1,48}|(DEV|CMD|AFF|OF|LOT|MVT|CQ|NC|CAPA|BL|FACT|BCF|PC|DER|MEX|MIA):[0-9]{4})$' THEN
    RAISE EXCEPTION 'Unsupported business-code sequence scope: %', p_scope
      USING ERRCODE = '22023';
  END IF;
  RETURN nextval('public.cerp_business_code_issue_seq'::regclass);
END;
$$;

COMMIT;
