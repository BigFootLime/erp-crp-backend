-- 20260729_piece_technique_document_policy_227.rollback.sql
-- Retrait GARDÉ et NON DESTRUCTIF du patch #227.
--
-- LIRE AVANT D'EXÉCUTER
-- Ce script ne s'exécute que si AUCUNE donnée métier n'a encore été saisie dans les
-- objets introduits par le patch. Dès qu'une politique a été posée sur un client, qu'une
-- pièce a été marquée critique ou qu'une version a été gelée, le retrait s'interrompt :
-- une exigence documentaire figée est une preuve, elle ne se supprime pas pour revenir
-- en arrière. Dans ce cas, corriger par la donnée (repasser les clients en 'NONE'),
-- pas par le schéma.
--
-- Le référentiel legacy public.documents_fournir n'est jamais touché, ni ici ni ailleurs.

BEGIN;

DO $$
DECLARE
  n_policies  bigint := 0;
  n_selection bigint := 0;
  n_critique  bigint := 0;
  n_frozen    bigint := 0;
  n_drafts    bigint := 0;
  n_typeddocs bigint := 0;
  n_custom    bigint := 0;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema='public' AND table_name='clients' AND column_name='document_policy') THEN
    SELECT count(*) INTO n_policies FROM public.clients WHERE document_policy <> 'NONE';
  END IF;

  IF to_regclass('public.client_document_requirements') IS NOT NULL THEN
    SELECT count(*) INTO n_selection FROM public.client_document_requirements;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema='public' AND table_name='pieces_techniques' AND column_name='piece_critique') THEN
    SELECT count(*) INTO n_critique FROM public.pieces_techniques WHERE piece_critique;
  END IF;

  IF to_regclass('public.piece_version_document_requirements') IS NOT NULL THEN
    SELECT count(*) INTO n_frozen FROM public.piece_version_document_requirements;
  END IF;

  IF to_regclass('public.piece_technique_create_drafts') IS NOT NULL THEN
    SELECT count(*) INTO n_drafts FROM public.piece_technique_create_drafts;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema='public' AND table_name='pieces_techniques_documents' AND column_name='document_type_code') THEN
    SELECT count(*) INTO n_typeddocs FROM public.pieces_techniques_documents WHERE document_type_code IS NOT NULL;
  END IF;

  IF to_regclass('public.piece_document_types') IS NOT NULL THEN
    SELECT count(*) INTO n_custom FROM public.piece_document_types WHERE NOT is_system;
  END IF;

  IF n_policies + n_selection + n_critique + n_frozen + n_drafts + n_typeddocs + n_custom > 0 THEN
    RAISE EXCEPTION
      '#227 rollback refuse — donnees metier presentes (politiques=%, selections=%, pieces critiques=%, exigences gelees=%, brouillons=%, documents types=%, types personnalises=%). Corriger par la donnee, pas par le schema.',
      n_policies, n_selection, n_critique, n_frozen, n_drafts, n_typeddocs, n_custom;
  END IF;
END $$;

-- À ce stade : aucune donnée métier. Le retrait est sûr.

ALTER TABLE public.pieces_techniques_documents DROP CONSTRAINT IF EXISTS pieces_techniques_documents_type_fkey;
ALTER TABLE public.pieces_techniques_documents DROP CONSTRAINT IF EXISTS pieces_techniques_documents_version_fkey;
DROP INDEX IF EXISTS public.pieces_techniques_documents_type_227_idx;
ALTER TABLE public.pieces_techniques_documents DROP COLUMN IF EXISTS document_type_code;
ALTER TABLE public.pieces_techniques_documents DROP COLUMN IF EXISTS piece_technique_version_id;

DROP TABLE IF EXISTS public.piece_version_document_requirements;
DROP TABLE IF EXISTS public.client_document_requirements;
DROP TABLE IF EXISTS public.piece_technique_create_drafts;
DROP TABLE IF EXISTS public.piece_document_types;

-- piece_technique_create_idempotence est PARTAGÉE avec le chantier #167 : on ne la
-- supprime pas ici, sa présence est inoffensive et sa suppression casserait l'autre branche.

ALTER TABLE public.piece_technique_versions DROP CONSTRAINT IF EXISTS piece_technique_versions_doc_policy_chk;
ALTER TABLE public.piece_technique_versions DROP COLUMN IF EXISTS document_requirements_frozen_at;
ALTER TABLE public.piece_technique_versions DROP COLUMN IF EXISTS document_requirements_policy;

DROP INDEX IF EXISTS public.pieces_techniques_critique_227_idx;
ALTER TABLE public.pieces_techniques DROP COLUMN IF EXISTS piece_critique;
ALTER TABLE public.pieces_techniques DROP COLUMN IF EXISTS piece_critique_motif;

ALTER TABLE public.clients DROP CONSTRAINT IF EXISTS clients_document_policy_chk;
ALTER TABLE public.clients DROP COLUMN IF EXISTS document_policy;
ALTER TABLE public.clients DROP COLUMN IF EXISTS document_policy_updated_at;
ALTER TABLE public.clients DROP COLUMN IF EXISTS document_policy_updated_by;

DELETE FROM public.cerp_schema_migrations
WHERE filename = '20260729_piece_technique_document_policy_227.sql';

COMMIT;
