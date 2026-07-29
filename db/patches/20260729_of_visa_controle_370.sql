-- 20260729_of_visa_controle_370.sql
--
-- Complément au VISA de phase (#370).
--
-- `of_operation_visas`, tel que créé par `20260729_of_versioning_replanification_ar_370.sql`,
-- ne portait que la signature : opérateur, initiales, horodatage, commentaire,
-- révocation. Le document d'OF exige davantage par phase : statut, quantités
-- bonne et rebut, motif de rebut, et un visa de CONTRÔLE distinct du visa
-- opérateur.
--
-- Pourquoi un second fichier plutôt qu'une reprise du premier : le premier est
-- déjà appliqué ET enregistré dans `cerp_schema_migrations` avec son empreinte.
-- Le modifier ferait divergier le fichier de son empreinte enregistrée, et le
-- registre cesserait de décrire ce qui a réellement tourné.
--
-- Le visa opérateur et le visa contrôle sont deux colonnes distinctes, pas un
-- champ « signataire » réutilisé : la séparation de celui qui fabrique et de
-- celui qui contrôle est le principe même du contrôle, et un schéma qui les
-- confond rend l'autocontrôle indétectable.
--
-- Intégralement additif et idempotent.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.of_operation_visas') IS NULL THEN
    RAISE EXCEPTION 'Prérequis manquant : 20260729_of_versioning_replanification_ar_370.sql doit être appliqué avant ce patch';
  END IF;
END $$;

ALTER TABLE public.of_operation_visas
  ADD COLUMN IF NOT EXISTS statut           text NOT NULL DEFAULT 'VISE',
  ADD COLUMN IF NOT EXISTS quantite_bonne   numeric(14, 3) NULL,
  ADD COLUMN IF NOT EXISTS quantite_rebut   numeric(14, 3) NULL,
  ADD COLUMN IF NOT EXISTS motif_rebut      text NULL,
  -- Visa de contrôle : identité, initiales et horodatage propres.
  ADD COLUMN IF NOT EXISTS controle_user_id integer NULL,
  ADD COLUMN IF NOT EXISTS controle_initials text NULL,
  ADD COLUMN IF NOT EXISTS controle_at      timestamptz NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'of_operation_visas_controle_user_fkey'
      AND conrelid = 'public.of_operation_visas'::regclass
  ) THEN
    ALTER TABLE public.of_operation_visas
      ADD CONSTRAINT of_operation_visas_controle_user_fkey
      FOREIGN KEY (controle_user_id) REFERENCES public.users (id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'of_operation_visas_statut_ck'
      AND conrelid = 'public.of_operation_visas'::regclass
  ) THEN
    ALTER TABLE public.of_operation_visas
      ADD CONSTRAINT of_operation_visas_statut_ck
      CHECK (statut IN ('A_FAIRE', 'EN_COURS', 'VISE', 'REFUSE'));
  END IF;

  -- Les quantités ne sont pas négatives. Un rebut négatif « rendrait » des
  -- pièces et fausserait tout comptage en aval.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'of_operation_visas_quantites_ck'
      AND conrelid = 'public.of_operation_visas'::regclass
  ) THEN
    ALTER TABLE public.of_operation_visas
      ADD CONSTRAINT of_operation_visas_quantites_ck
      CHECK ((quantite_bonne IS NULL OR quantite_bonne >= 0)
         AND (quantite_rebut IS NULL OR quantite_rebut >= 0));
  END IF;

  -- Un rebut déclaré sans motif est une information perdue : la cause d'un rebut
  -- est ce qui permet de ne pas le reproduire.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'of_operation_visas_rebut_motif_ck'
      AND conrelid = 'public.of_operation_visas'::regclass
  ) THEN
    ALTER TABLE public.of_operation_visas
      ADD CONSTRAINT of_operation_visas_rebut_motif_ck
      CHECK (COALESCE(quantite_rebut, 0) = 0
             OR (motif_rebut IS NOT NULL AND btrim(motif_rebut) <> ''));
  END IF;

  -- Un visa de contrôle n'existe pas sans son horodatage ni ses initiales.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'of_operation_visas_controle_ck'
      AND conrelid = 'public.of_operation_visas'::regclass
  ) THEN
    ALTER TABLE public.of_operation_visas
      ADD CONSTRAINT of_operation_visas_controle_ck
      CHECK ((controle_initials IS NULL AND controle_at IS NULL)
          OR (controle_initials IS NOT NULL AND controle_at IS NOT NULL));
  END IF;
END $$;

COMMENT ON COLUMN public.of_operation_visas.statut IS
  'Statut du VISA de la phase : A_FAIRE, EN_COURS, VISE, REFUSE.';
COMMENT ON COLUMN public.of_operation_visas.controle_initials IS
  'Initiales du CONTRÔLE, distinctes du visa opérateur : séparer qui fabrique de qui contrôle est le principe du contrôle.';

/* -------------------------------------------------------------------------- */
/* Immuabilité — le trigger existant doit couvrir les nouvelles colonnes       */
/* -------------------------------------------------------------------------- */
-- Le trigger d'origine (`fn_of_operation_visas_append_only`) protégeait les
-- colonnes de signature. Les quantités et le motif déclarés entrent dans la même
-- catégorie : un VISA se révoque, il ne se réécrit pas. Sans cette extension, une
-- quantité rebut pourrait être corrigée après coup sans laisser de trace.
CREATE OR REPLACE FUNCTION public.fn_of_operation_visas_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Un VISA ne se supprime pas : il se révoque'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.of_operation_id IS DISTINCT FROM OLD.of_operation_id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.initials IS DISTINCT FROM OLD.initials
     OR NEW.visa_at IS DISTINCT FROM OLD.visa_at
     OR NEW.quantite_bonne IS DISTINCT FROM OLD.quantite_bonne
     OR NEW.quantite_rebut IS DISTINCT FROM OLD.quantite_rebut
     OR NEW.motif_rebut IS DISTINCT FROM OLD.motif_rebut
     OR NEW.controle_user_id IS DISTINCT FROM OLD.controle_user_id
     OR NEW.controle_initials IS DISTINCT FROM OLD.controle_initials
     OR NEW.controle_at IS DISTINCT FROM OLD.controle_at THEN
    RAISE EXCEPTION 'Un VISA signé est immuable : seules la révocation et son motif peuvent être renseignés'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_of_operation_visas_append_only ON public.of_operation_visas;
CREATE TRIGGER trg_of_operation_visas_append_only
  BEFORE UPDATE OR DELETE ON public.of_operation_visas
  FOR EACH ROW EXECUTE FUNCTION public.fn_of_operation_visas_append_only();

/* -------------------------------------------------------------------------- */
/* Propriété applicative                                                      */
/* -------------------------------------------------------------------------- */
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app') THEN
    ALTER TABLE public.of_operation_visas OWNER TO cerp_app;
  END IF;
END $$;

COMMIT;
