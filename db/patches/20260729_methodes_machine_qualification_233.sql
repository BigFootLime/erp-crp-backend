-- 20260729_methodes_machine_qualification_233.sql
--
-- Méthodes — qualification traçable du parc machine (#233 / crp-systems-web#384).
-- ADR : crp-systems-web/docs/adr/ADR-0046-methodes-referentiels-gamme.md
--
-- COMPLÉMENT de 20260729_methodes_gamme_referentials.sql, qui a créé les
-- référentiels et les colonnes `machines.machine_family_code` / `machines.cf_id`
-- SANS aucun backfill. Ce patch n'affecte toujours AUCUNE famille : il crée
-- seulement le JOURNAL qui rend l'affectation traçable et réversible.
--
-- ADDITIF, IDEMPOTENT, NON DESTRUCTIF :
--   - 1 nouvelle table (`production_machine_qualifications`) ;
--   - 1 index unique conditionnel rejoué (phases de gamme) ;
--   - AUCUN UPDATE, AUCUN DELETE, AUCUN DROP sur des données existantes.
--
-- POURQUOI UN JOURNAL PLUTÔT QU'UNE SIMPLE COLONNE : affecter une machine à une
-- famille change le calcul de coût des gammes futures et l'exigence de numéro de
-- programme. Une valeur seule ne dit ni qui, ni quand, ni pourquoi. Le journal
-- porte l'ancienne ET la nouvelle valeur, donc l'affectation reste réversible
-- sans reconstitution.
--
-- Pipeline db/patches (exécuté en tant que `cerp_app`). Cible : PostgreSQL 17.
--   Preflight : db/patches/support/20260729_methodes_machine_qualification_233.preflight.sql
--   Verify    : db/patches/support/20260729_methodes_machine_qualification_233.verify.sql
--   Rollback  : db/patches/support/20260729_methodes_machine_qualification_233.rollback.sql
-- Si le patch est appliqué via `sudo -u postgres psql`, exécuter ensuite
-- db/privileged/20260721_fix_app_table_ownership.sql : sinon `cerp_app` obtient
-- 42501 puis l'API renvoie 500 alors que le schéma est correct.

BEGIN;

/* -------------------------------------------------------------------------- */
/* 0) Pré-requis structurels                                                  */
/* -------------------------------------------------------------------------- */

DO $$
BEGIN
  IF to_regclass('public.production_machine_families') IS NULL THEN
    RAISE EXCEPTION 'methodes: production_machine_families absent — appliquer 20260729_methodes_gamme_referentials.sql';
  END IF;
  IF to_regclass('public.machines') IS NULL THEN
    RAISE EXCEPTION 'methodes: public.machines est absent';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'machines' AND column_name = 'machine_family_code'
  ) THEN
    RAISE EXCEPTION 'methodes: machines.machine_family_code absent — appliquer 20260729_methodes_gamme_referentials.sql';
  END IF;
END $$;

/* -------------------------------------------------------------------------- */
/* 1) Journal de qualification du parc machine                                */
/* -------------------------------------------------------------------------- */
-- Une ligne = une décision humaine de qualification. `motif` est OBLIGATOIRE :
-- une affectation sans justification écrite est exactement ce que l'audit
-- reproche aux référentiels hérités.
--
-- PAS de clé étrangère vers `production_machine_families` sur les codes
-- conservés : le journal est une preuve. Une famille désactivée ou renommée ne
-- doit ni bloquer l'écriture, ni effacer ce qui a été décidé.

CREATE TABLE IF NOT EXISTS public.production_machine_qualifications (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  machine_id           uuid NOT NULL,
  -- État AVANT décision.
  previous_family_code text,
  previous_cf_id       uuid,
  previous_valid_from  date,
  previous_valid_to    date,
  -- État APRÈS décision.
  new_family_code      text,
  new_cf_id            uuid,
  new_valid_from       date,
  new_valid_to         date,
  motif                text NOT NULL,
  created_at           timestamp with time zone NOT NULL DEFAULT now(),
  created_by           integer
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'machine_qualifications_machine_fkey'
      AND conrelid = 'public.production_machine_qualifications'::regclass
  ) THEN
    ALTER TABLE public.production_machine_qualifications
      ADD CONSTRAINT machine_qualifications_machine_fkey
      FOREIGN KEY (machine_id) REFERENCES public.machines (id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'machine_qualifications_created_by_fkey'
      AND conrelid = 'public.production_machine_qualifications'::regclass
  ) THEN
    ALTER TABLE public.production_machine_qualifications
      ADD CONSTRAINT machine_qualifications_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES public.users (id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'machine_qualifications_motif_ck'
      AND conrelid = 'public.production_machine_qualifications'::regclass
  ) THEN
    ALTER TABLE public.production_machine_qualifications
      ADD CONSTRAINT machine_qualifications_motif_ck CHECK (btrim(motif) <> '');
  END IF;
  -- Une ligne de journal qui ne change rien n'est pas une décision.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'machine_qualifications_change_ck'
      AND conrelid = 'public.production_machine_qualifications'::regclass
  ) THEN
    ALTER TABLE public.production_machine_qualifications
      ADD CONSTRAINT machine_qualifications_change_ck
      CHECK (
        previous_family_code IS DISTINCT FROM new_family_code
        OR previous_cf_id      IS DISTINCT FROM new_cf_id
        OR previous_valid_from IS DISTINCT FROM new_valid_from
        OR previous_valid_to   IS DISTINCT FROM new_valid_to
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'machine_qualifications_validity_ck'
      AND conrelid = 'public.production_machine_qualifications'::regclass
  ) THEN
    ALTER TABLE public.production_machine_qualifications
      ADD CONSTRAINT machine_qualifications_validity_ck
      CHECK (new_valid_from IS NULL OR new_valid_to IS NULL OR new_valid_to >= new_valid_from);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS machine_qualifications_machine_idx
  ON public.production_machine_qualifications (machine_id, created_at DESC);

/* -------------------------------------------------------------------------- */
/* 2) Anti-collision des phases — nouvelle tentative                          */
/* -------------------------------------------------------------------------- */
-- Le patch précédent n'a pas pu créer cet index sur une base portant déjà deux
-- opérations à la même phase dans une même gamme (constaté sur `cerp_test`).
-- La garde est rejouée : dès que le doublon est renuméroté côté métier, une
-- réapplication crée l'index. Aucune donnée n'est modifiée ici.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class WHERE relname = 'pt_operations_gamme_phase_uidx' AND relkind = 'i'
  ) AND NOT EXISTS (
    SELECT 1 FROM public.pieces_techniques_operations
    WHERE gamme_id IS NOT NULL
    GROUP BY gamme_id, phase HAVING count(*) > 1
  ) THEN
    CREATE UNIQUE INDEX pt_operations_gamme_phase_uidx
      ON public.pieces_techniques_operations (gamme_id, phase)
      WHERE gamme_id IS NOT NULL;
  ELSIF NOT EXISTS (
    SELECT 1 FROM pg_class WHERE relname = 'pt_operations_gamme_phase_uidx' AND relkind = 'i'
  ) THEN
    RAISE NOTICE 'methodes: index (gamme_id, phase) NON créé — doublons de phase à renuméroter, voir le verify.';
  END IF;
END $$;

/* -------------------------------------------------------------------------- */
/* 3) Catalogue d'accès (#326) — la page « Parc machine » rejoint le module    */
/* -------------------------------------------------------------------------- */
-- Mise à jour ciblée d'une ligne de CATALOGUE (pas de donnée métier), pour que
-- la base reste le miroir de `module-catalog.ts`. Sans cette page key, l'entrée
-- de navigation disparaîtrait de tout compte dont le profil d'accès est filtré.
-- `access_modules` n'existe pas encore sur toutes les bases : la garde évite un
-- échec de patch là où le module d'accès n'est pas déployé.

DO $$
BEGIN
  IF to_regclass('public.access_modules') IS NOT NULL THEN
    UPDATE public.access_modules
    SET nav_page_keys = array_append(nav_page_keys, 'methodes-parc-machines'),
        updated_at    = now()
    WHERE module_key = 'pieces-techniques'
      AND NOT ('methodes-parc-machines' = ANY (nav_page_keys));
  ELSE
    RAISE NOTICE 'methodes: access_modules absent — catalogue d''accès non applicable sur cette base.';
  END IF;
END $$;

/* -------------------------------------------------------------------------- */
/* 4) Documentation embarquée                                                 */
/* -------------------------------------------------------------------------- */

COMMENT ON TABLE public.production_machine_qualifications IS
  'Journal des décisions de qualification machine (famille, centre de frais, validité). Ancienne et nouvelle valeur conservées : l''affectation reste réversible et auditable.';
COMMENT ON COLUMN public.production_machine_qualifications.motif IS
  'Justification écrite obligatoire de la décision. Une affectation sans motif n''est pas acceptée.';

COMMIT;
