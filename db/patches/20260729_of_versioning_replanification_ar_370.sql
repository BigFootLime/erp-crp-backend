-- 20260729_of_versioning_replanification_ar_370.sql
--
-- Chantier « OF, versioning, replanification, AR client et export PDF » (#370).
--
-- Reprise réconciliée du travail non livré de `feature/of-versioning-planning-ar-pdf`.
-- Le schéma d'origine reste juste ; ce qui a changé depuis, c'est la normalisation
-- des gammes (`20260729_methodes_gamme_referentials.sql`), qui a doté
-- `of_operations` de `numero_programme`, `machine_family_code`, `cf_code_snapshot`,
-- `cf_rate_id`, `temps_fabrication_planned`, `hourly_rate_source` et
-- `hourly_rate_effective_at`. La section F ci-dessous raccorde ce chantier à ce
-- référentiel au lieu de le contourner.
--
-- ÉTAT DES BASES AU MOMENT DE L'ÉCRITURE (vérifié en lecture seule) :
--   - `cerp_test` porte DÉJÀ les objets A→E, mais `cerp_schema_migrations` ne
--     l'enregistre pas. Ce patch y est donc un quasi no-op : chaque commande est
--     gardée, aucune ne suppose une base vierge.
--   - `cerp_prod` ne porte AUCUN de ces objets. Il y fait l'installation complète.
--   - `ordres_fabrication` et `of_operations` sont à 0 ligne sur les DEUX bases :
--     le backfill R00 est un no-op et le passage en NOT NULL ne bute sur rien.
--
-- Apporte les fondations manquantes :
--   A) révisions d'OF (R00, R01, …), snapshot technique par révision, hash, diff,
--      VISA par phase, révision obsolète ;
--   B) propositions de replanification issues d'une dérive de temps d'usinage ;
--   C) versions de planning d'OF (ACTIF → BROUILLON → SOUMIS → VALIDE/REFUSE → ACTIF) ;
--   D) dossiers d'AR client à recaler + routage de notification configurable ;
--   E) documents d'OF figés (payload immuable, empreinte, lien GED).
--
-- Sécurité
-- - Patch idempotent : rejouable sans effet de bord.
-- - Additif sauf UNE contrainte : `of_operations_of_id_phase_key` (of_id, phase) devient
--   (of_id, revision_id, phase). C'est la condition pour qu'une R01 coexiste avec la R00
--   d'un OF lancé au lieu de l'écraser. Le rollback rétablit l'ancienne contrainte.
-- - À appliquer sur `cerp_test` après preflight. JAMAIS sur `cerp_prod` sans sauvegarde
--   approuvée, rapport de vérification et autorisation humaine explicite.

BEGIN;

/* -------------------------------------------------------------------------- */
/* 0) Preflight                                                               */
/* -------------------------------------------------------------------------- */

DO $$
BEGIN
  IF to_regclass('public.ordres_fabrication') IS NULL
     OR to_regclass('public.of_operations') IS NULL
     OR to_regclass('public.of_time_logs') IS NULL
     OR to_regclass('public.users') IS NULL
     OR to_regclass('public.affaire') IS NULL
     OR to_regclass('public.commande_client') IS NULL THEN
    RAISE EXCEPTION 'Prérequis manquant : écosystème OF (#55/#141/#170) requis';
  END IF;
END $$;

/* ========================================================================== */
/* A) RÉVISIONS D'OF                                                          */
/* ========================================================================== */

-- Une révision fige la définition applicable d'un OF à un instant donné : gamme,
-- matière, machines, temps, quantités. Le numéro d'OF, lui, ne bouge jamais
-- (trigger `fn_prevent_of_numero_mutation`, #170) : c'est la révision qui porte
-- l'évolution, pas l'identifiant.
CREATE TABLE IF NOT EXISTS public.of_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  of_id bigint NOT NULL REFERENCES public.ordres_fabrication(id) ON DELETE RESTRICT,

  -- Rang entier (0, 1, 2…) et code d'affichage dérivé ('R00', 'R01', …).
  -- Le code est stocké et contraint plutôt que calculé à la lecture : il est
  -- imprimé sur un document opposable et cité dans les pointages.
  revision_rank integer NOT NULL,
  revision_code text NOT NULL,

  statut text NOT NULL DEFAULT 'BROUILLON',

  -- Instantané technique complet de la révision.
  snapshot jsonb NOT NULL,
  snapshot_sha256 text NOT NULL,

  -- Écart avec la révision précédente, calculé au moment de la création.
  diff jsonb NULL,

  -- Motif : facultatif sur R00 (création), obligatoire dès R01 (voir trigger).
  motif text NULL,

  author_user_id integer NULL REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz NULL,
  superseded_at timestamptz NULL,
  superseded_by uuid NULL REFERENCES public.of_revisions(id) ON DELETE SET NULL,

  CONSTRAINT of_revisions_rank_uq UNIQUE (of_id, revision_rank),
  CONSTRAINT of_revisions_code_uq UNIQUE (of_id, revision_code),
  CONSTRAINT of_revisions_rank_ck CHECK (revision_rank >= 0),
  CONSTRAINT of_revisions_code_ck CHECK (revision_code ~ '^R[0-9]{2,}$'),
  CONSTRAINT of_revisions_statut_ck CHECK (statut IN ('BROUILLON', 'ACTIVE', 'OBSOLETE')),
  CONSTRAINT of_revisions_sha256_ck CHECK (snapshot_sha256 ~ '^[a-f0-9]{64}$'),
  CONSTRAINT of_revisions_motif_ck CHECK (revision_rank = 0 OR (motif IS NOT NULL AND btrim(motif) <> ''))
);

-- Une seule révision ACTIVE par OF : c'est elle qui est applicable en atelier.
CREATE UNIQUE INDEX IF NOT EXISTS of_revisions_active_uq
  ON public.of_revisions(of_id)
  WHERE statut = 'ACTIVE';

CREATE INDEX IF NOT EXISTS of_revisions_of_idx
  ON public.of_revisions(of_id, revision_rank DESC);

COMMENT ON TABLE public.of_revisions IS
  'Révisions d''un OF. Le numéro d''OF est stable ; la révision porte l''évolution technique. Une révision ACTIVE au plus par OF.';
COMMENT ON COLUMN public.of_revisions.snapshot IS
  'Instantané figé : gamme applicable, matière, machines, temps, quantités. Immuable après création.';
COMMENT ON COLUMN public.of_revisions.diff IS
  'Écart structuré avec la révision précédente (ajouts, retraits, modifications champ par champ).';

-- Le snapshot d'une révision est immuable. Seul le cycle de vie (statut, dates,
-- chaînage) peut évoluer : une révision qui se réécrirait ne prouverait plus rien.
CREATE OR REPLACE FUNCTION public.fn_of_revisions_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Une révision d''OF ne se supprime pas : elle devient OBSOLETE'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.of_id IS DISTINCT FROM OLD.of_id
     OR NEW.revision_rank IS DISTINCT FROM OLD.revision_rank
     OR NEW.revision_code IS DISTINCT FROM OLD.revision_code
     OR NEW.snapshot IS DISTINCT FROM OLD.snapshot
     OR NEW.snapshot_sha256 IS DISTINCT FROM OLD.snapshot_sha256
     OR NEW.diff IS DISTINCT FROM OLD.diff
     OR NEW.motif IS DISTINCT FROM OLD.motif
     OR NEW.author_user_id IS DISTINCT FROM OLD.author_user_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Le contenu d''une révision d''OF est immuable après création'
      USING ERRCODE = '55000';
  END IF;

  -- Une révision OBSOLETE est terminale.
  IF OLD.statut = 'OBSOLETE' AND NEW.statut <> 'OBSOLETE' THEN
    RAISE EXCEPTION 'Une révision obsolète ne peut pas être réactivée'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_of_revisions_immutable ON public.of_revisions;
CREATE TRIGGER trg_of_revisions_immutable
  BEFORE UPDATE OR DELETE ON public.of_revisions
  FOR EACH ROW EXECUTE FUNCTION public.fn_of_revisions_immutable();

/* --- Rattachement des opérations à leur révision --------------------------- */

ALTER TABLE public.of_operations
  ADD COLUMN IF NOT EXISTS revision_id uuid NULL REFERENCES public.of_revisions(id) ON DELETE RESTRICT;

-- Backfill : chaque OF existant reçoit sa R00 ACTIVE, et ses opérations s'y
-- rattachent. Le snapshot de reprise est marqué comme tel : il est reconstruit à
-- partir de l'état courant, il n'a pas été figé au lancement.
DO $$
DECLARE
  v_of RECORD;
  v_revision_id uuid;
  v_snapshot jsonb;
BEGIN
  FOR v_of IN
    SELECT o.id
    FROM public.ordres_fabrication o
    WHERE NOT EXISTS (SELECT 1 FROM public.of_revisions r WHERE r.of_id = o.id)
  LOOP
    SELECT jsonb_build_object(
             'origin', 'BACKFILL',
             'of_id', v_of.id,
             'operations', COALESCE(
               (SELECT jsonb_agg(jsonb_build_object(
                         'phase', op.phase,
                         'designation', op.designation,
                         'machine_id', op.machine_id,
                         'poste_id', op.poste_id,
                         'cf_id', op.cf_id,
                         'tp', op.tp,
                         'tf_unit', op.tf_unit,
                         'qte', op.qte,
                         'coef', op.coef
                       ) ORDER BY op.phase)
                FROM public.of_operations op
                WHERE op.of_id = v_of.id),
               '[]'::jsonb)
           )
      INTO v_snapshot;

    INSERT INTO public.of_revisions (
      of_id, revision_rank, revision_code, statut, snapshot, snapshot_sha256, activated_at
    )
    VALUES (
      v_of.id, 0, 'R00', 'ACTIVE', v_snapshot,
      encode(digest(v_snapshot::text, 'sha256'), 'hex'),
      now()
    )
    RETURNING id INTO v_revision_id;

    UPDATE public.of_operations
      SET revision_id = v_revision_id
      WHERE of_id = v_of.id AND revision_id IS NULL;
  END LOOP;
END $$;

-- La clé d'unicité passe de (of_id, phase) à (of_id, revision_id, phase).
-- Sans ce changement, créer une R01 sur un OF lancé exigerait de supprimer ou de
-- muter les opérations de la R00 — donc d'écraser les pointages et les VISA qui y
-- sont rattachés. C'est précisément ce que le chantier interdit.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'of_operations_of_id_phase_key'
      AND conrelid = 'public.of_operations'::regclass
  ) THEN
    ALTER TABLE public.of_operations DROP CONSTRAINT of_operations_of_id_phase_key;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'of_operations_of_revision_phase_key'
      AND conrelid = 'public.of_operations'::regclass
  ) THEN
    ALTER TABLE public.of_operations
      ADD CONSTRAINT of_operations_of_revision_phase_key UNIQUE (of_id, revision_id, phase);
  END IF;
END $$;

-- `revision_id` ne devient NOT NULL que si le backfill est complet : le patch ne
-- doit jamais échouer sur des lignes historiques qu'il ne maîtrise pas.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.of_operations WHERE revision_id IS NULL) THEN
    BEGIN
      ALTER TABLE public.of_operations ALTER COLUMN revision_id SET NOT NULL;
    EXCEPTION WHEN others THEN
      RAISE NOTICE 'of_operations.revision_id laissé nullable : %', SQLERRM;
    END;
  ELSE
    RAISE NOTICE 'of_operations.revision_id laissé nullable : % ligne(s) non rattachée(s)',
      (SELECT count(*) FROM public.of_operations WHERE revision_id IS NULL);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS of_operations_revision_idx
  ON public.of_operations(revision_id)
  WHERE revision_id IS NOT NULL;

COMMENT ON COLUMN public.of_operations.revision_id IS
  'Révision d''OF dont cette opération fait partie. Les pointages et VISA suivent l''opération, donc restent attachés à leur révision d''origine.';

-- Une opération d'une révision obsolète est un fait historique : elle porte des
-- pointages et des VISA déjà signés. Elle ne se modifie plus.
CREATE OR REPLACE FUNCTION public.fn_of_operations_obsolete_revision_readonly()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_statut text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT statut INTO v_statut FROM public.of_revisions WHERE id = OLD.revision_id;
    IF v_statut = 'OBSOLETE' THEN
      RAISE EXCEPTION 'Opération d''une révision obsolète : suppression interdite'
        USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;

  SELECT statut INTO v_statut FROM public.of_revisions WHERE id = OLD.revision_id;
  IF v_statut = 'OBSOLETE' AND NEW.revision_id IS NOT DISTINCT FROM OLD.revision_id THEN
    RAISE EXCEPTION 'Opération d''une révision obsolète : modification interdite'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_of_operations_obsolete_revision_readonly ON public.of_operations;
CREATE TRIGGER trg_of_operations_obsolete_revision_readonly
  BEFORE UPDATE OR DELETE ON public.of_operations
  FOR EACH ROW EXECUTE FUNCTION public.fn_of_operations_obsolete_revision_readonly();

/* --- VISA de phase --------------------------------------------------------- */

-- Le VISA est la signature de l'opérateur qui atteste avoir exécuté la phase
-- (colonne « VISA » de la gamme de fabrication papier). Il porte les initiales
-- telles qu'elles étaient au moment du visa : un changement de nom ultérieur ne
-- doit pas réécrire un document déjà imprimé.
CREATE TABLE IF NOT EXISTS public.of_operation_visas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  of_operation_id uuid NOT NULL REFERENCES public.of_operations(id) ON DELETE RESTRICT,
  user_id integer NULL REFERENCES public.users(id) ON DELETE SET NULL,
  initials text NOT NULL,
  visa_at timestamptz NOT NULL DEFAULT now(),
  comment text NULL,
  revoked_at timestamptz NULL,
  revoked_by integer NULL REFERENCES public.users(id) ON DELETE SET NULL,
  revoked_reason text NULL,
  CONSTRAINT of_operation_visas_initials_ck CHECK (btrim(initials) <> '' AND char_length(initials) <= 8)
);

-- Un seul VISA vivant par opération.
CREATE UNIQUE INDEX IF NOT EXISTS of_operation_visas_live_uq
  ON public.of_operation_visas(of_operation_id)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS of_operation_visas_operation_idx
  ON public.of_operation_visas(of_operation_id);

COMMENT ON TABLE public.of_operation_visas IS
  'VISA de phase : signature de l''opérateur. Les initiales sont figées à la signature. Un VISA se révoque, il ne se supprime pas.';

CREATE OR REPLACE FUNCTION public.fn_of_operation_visas_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Un VISA ne se supprime pas : il se révoque' USING ERRCODE = '55000';
  END IF;
  IF NEW.of_operation_id IS DISTINCT FROM OLD.of_operation_id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.initials IS DISTINCT FROM OLD.initials
     OR NEW.visa_at IS DISTINCT FROM OLD.visa_at THEN
    RAISE EXCEPTION 'Un VISA signé est immuable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_of_operation_visas_append_only ON public.of_operation_visas;
CREATE TRIGGER trg_of_operation_visas_append_only
  BEFORE UPDATE OR DELETE ON public.of_operation_visas
  FOR EACH ROW EXECUTE FUNCTION public.fn_of_operation_visas_append_only();

/* ========================================================================== */
/* B) DÉRIVE DU TEMPS D'USINAGE                                               */
/* ========================================================================== */

-- Après programmation d'une phase, le temps de fabrication constaté est comparé
-- au temps validé de référence. Au-delà du seuil, une PROPOSITION est créée —
-- jamais une modification du planning actif.
CREATE TABLE IF NOT EXISTS public.of_time_variance_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  of_id bigint NOT NULL REFERENCES public.ordres_fabrication(id) ON DELETE RESTRICT,
  revision_id uuid NOT NULL REFERENCES public.of_revisions(id) ON DELETE RESTRICT,
  of_operation_id uuid NULL REFERENCES public.of_operations(id) ON DELETE SET NULL,
  phase integer NOT NULL,

  -- Temps en heures. `reference_time` NULL ou 0 => revue obligatoire, pas de
  -- pourcentage : diviser par zéro ne produit pas une information, il en détruit une.
  reference_time numeric(12, 4) NULL,
  new_time numeric(12, 4) NOT NULL,
  variation_pct numeric(10, 2) NULL,

  -- Décision : RIEN (sous seuil), REPLANIFICATION (au-dessus), REVUE (référence absente).
  outcome text NOT NULL,
  review_required boolean NOT NULL DEFAULT false,

  cause text NOT NULL,
  cause_comment text NULL,

  -- Contexte d'impact, figé au moment de la proposition.
  impact_charge jsonb NOT NULL DEFAULT '{}'::jsonb,
  machines jsonb NOT NULL DEFAULT '[]'::jsonb,
  affaires jsonb NOT NULL DEFAULT '[]'::jsonb,
  simulation jsonb NOT NULL DEFAULT '{}'::jsonb,

  statut text NOT NULL DEFAULT 'OUVERTE',
  author_user_id integer NULL REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz NULL,
  resolved_by integer NULL REFERENCES public.users(id) ON DELETE SET NULL,
  resolution_comment text NULL,

  -- Clé d'idempotence : rejouer la même programmation ne crée pas un doublon.
  idempotency_key text NULL,

  CONSTRAINT of_time_variance_outcome_ck CHECK (outcome IN ('RIEN', 'REPLANIFICATION', 'REVUE')),
  CONSTRAINT of_time_variance_statut_ck CHECK (statut IN ('OUVERTE', 'ACCEPTEE', 'REFUSEE', 'CADUQUE')),
  CONSTRAINT of_time_variance_new_time_ck CHECK (new_time >= 0),
  CONSTRAINT of_time_variance_cause_ck CHECK (btrim(cause) <> ''),
  -- Une variation n'existe que si la référence est exploitable, et réciproquement.
  CONSTRAINT of_time_variance_pct_ck CHECK (
    (reference_time IS NULL OR reference_time = 0) = (variation_pct IS NULL)
  ),
  -- Référence inexploitable => revue obligatoire.
  CONSTRAINT of_time_variance_review_ck CHECK (
    NOT (reference_time IS NULL OR reference_time = 0) OR (outcome = 'REVUE' AND review_required)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS of_time_variance_idempotency_uq
  ON public.of_time_variance_proposals(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS of_time_variance_of_idx
  ON public.of_time_variance_proposals(of_id, created_at DESC);

CREATE INDEX IF NOT EXISTS of_time_variance_open_idx
  ON public.of_time_variance_proposals(created_at DESC)
  WHERE statut = 'OUVERTE';

COMMENT ON TABLE public.of_time_variance_proposals IS
  'Proposition de replanification issue d''une dérive de temps d''usinage. N''altère jamais le planning actif : elle se soumet à décision.';
COMMENT ON COLUMN public.of_time_variance_proposals.variation_pct IS
  '((nouveau - référence) / référence) x 100, arrondi à 2 décimales. NULL quand la référence est absente ou nulle.';

/* ========================================================================== */
/* C) VERSIONS DE PLANNING D'OF                                               */
/* ========================================================================== */

-- Toute retouche du planning d'un OF crée un brouillon versionné. Le planning
-- ACTIF reste inchangé tant que le brouillon n'est pas validé.
CREATE TABLE IF NOT EXISTS public.of_planning_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  of_id bigint NOT NULL REFERENCES public.ordres_fabrication(id) ON DELETE RESTRICT,
  revision_id uuid NULL REFERENCES public.of_revisions(id) ON DELETE SET NULL,

  version_rank integer NOT NULL,
  statut text NOT NULL DEFAULT 'BROUILLON',

  -- Plan complet : opérations, dates, machines, durées, charge, quantité, cadence.
  payload jsonb NOT NULL,
  payload_sha256 text NOT NULL,

  -- Comparaison avant/après avec le plan ACTIF au moment de la création.
  base_version_id uuid NULL REFERENCES public.of_planning_versions(id) ON DELETE SET NULL,
  comparison jsonb NULL,

  -- Conséquence client déduite de la comparaison : décide si un dossier AR est requis.
  client_impact text NOT NULL DEFAULT 'AUCUN',

  -- Proposition de dérive à l'origine du brouillon, s'il y en a une.
  source_proposal_id uuid NULL REFERENCES public.of_time_variance_proposals(id) ON DELETE SET NULL,

  author_user_id integer NULL REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz NULL,
  submitted_by integer NULL REFERENCES public.users(id) ON DELETE SET NULL,
  decided_at timestamptz NULL,
  decided_by integer NULL REFERENCES public.users(id) ON DELETE SET NULL,
  decision_comment text NULL,
  activated_at timestamptz NULL,
  superseded_at timestamptz NULL,

  idempotency_key text NULL,

  CONSTRAINT of_planning_versions_rank_uq UNIQUE (of_id, version_rank),
  CONSTRAINT of_planning_versions_rank_ck CHECK (version_rank >= 0),
  CONSTRAINT of_planning_versions_statut_ck
    CHECK (statut IN ('ACTIF', 'BROUILLON', 'SOUMIS', 'VALIDE', 'REFUSE', 'SUPERSEDE')),
  CONSTRAINT of_planning_versions_sha256_ck CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
  CONSTRAINT of_planning_versions_impact_ck
    CHECK (client_impact IN ('AUCUN', 'DELAI', 'CADENCE', 'DELAI_ET_CADENCE'))
);

-- Un seul plan ACTIF par OF, et un seul brouillon en cours de circuit.
CREATE UNIQUE INDEX IF NOT EXISTS of_planning_versions_active_uq
  ON public.of_planning_versions(of_id)
  WHERE statut = 'ACTIF';

CREATE UNIQUE INDEX IF NOT EXISTS of_planning_versions_open_draft_uq
  ON public.of_planning_versions(of_id)
  WHERE statut IN ('BROUILLON', 'SOUMIS');

CREATE UNIQUE INDEX IF NOT EXISTS of_planning_versions_idempotency_uq
  ON public.of_planning_versions(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS of_planning_versions_of_idx
  ON public.of_planning_versions(of_id, version_rank DESC);

COMMENT ON TABLE public.of_planning_versions IS
  'Versions de planning d''un OF. Cycle ACTIF -> BROUILLON -> SOUMIS -> VALIDE/REFUSE -> ACTIF. Le plan ACTIF n''est jamais modifié en place.';

/* ========================================================================== */
/* D) DOSSIER D'AR CLIENT À RECALER                                           */
/* ========================================================================== */

-- Distinct de `commande_ar_log`, qui journalise l'AR **envoyé** au client.
-- Ici il s'agit du dossier interne ouvert quand un plan validé casse un
-- engagement déjà accusé : délai ou cadence. Aucun envoi n'y est automatisé.
CREATE TABLE IF NOT EXISTS public.ar_recalage_dossiers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  client_id character varying(3) NULL REFERENCES public.clients(client_id) ON DELETE SET NULL,
  commande_id bigint NULL REFERENCES public.commande_client(id) ON DELETE SET NULL,
  affaire_id bigint NULL REFERENCES public.affaire(id) ON DELETE SET NULL,
  of_id bigint NOT NULL REFERENCES public.ordres_fabrication(id) ON DELETE RESTRICT,
  planning_version_id uuid NULL REFERENCES public.of_planning_versions(id) ON DELETE SET NULL,

  previous_date date NULL,
  previous_cadence jsonb NULL,
  new_date date NULL,
  new_cadence jsonb NULL,
  quantite numeric(14, 3) NULL,

  motif text NOT NULL,
  commentaire text NULL,

  statut text NOT NULL DEFAULT 'A_TRAITER',
  owner_user_id integer NULL REFERENCES public.users(id) ON DELETE SET NULL,

  created_at timestamptz NOT NULL DEFAULT now(),
  created_by integer NULL REFERENCES public.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz NULL,
  closed_by integer NULL REFERENCES public.users(id) ON DELETE SET NULL,

  idempotency_key text NULL,

  CONSTRAINT ar_recalage_motif_ck CHECK (motif IN (
    'DERIVE_TEMPS_USINAGE',
    'MACHINE',
    'MATIERE',
    'QUALITE_REPRISE',
    'SOUS_TRAITANCE',
    'MODIFICATION_TECHNIQUE',
    'CAPACITE',
    'PRIORITE',
    'AUTRE'
  )),
  CONSTRAINT ar_recalage_statut_ck CHECK (statut IN ('A_TRAITER', 'EN_COURS', 'RECALE', 'ABANDONNE')),
  -- « Autre » n'est pas un motif : c'est une invitation à l'écrire.
  CONSTRAINT ar_recalage_autre_comment_ck
    CHECK (motif <> 'AUTRE' OR (commentaire IS NOT NULL AND btrim(commentaire) <> ''))
);

CREATE UNIQUE INDEX IF NOT EXISTS ar_recalage_idempotency_uq
  ON public.ar_recalage_dossiers(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS ar_recalage_open_idx
  ON public.ar_recalage_dossiers(created_at DESC)
  WHERE statut IN ('A_TRAITER', 'EN_COURS');

CREATE INDEX IF NOT EXISTS ar_recalage_commande_idx
  ON public.ar_recalage_dossiers(commande_id)
  WHERE commande_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ar_recalage_of_idx
  ON public.ar_recalage_dossiers(of_id);

COMMENT ON TABLE public.ar_recalage_dossiers IS
  'Dossier interne de recalage d''un AR client. Aucun envoi automatique : la reprise de contact reste un geste humain.';

/* --- Routage de notification configurable ---------------------------------- */

-- Qui est prévenu d'un sujet donné est une donnée de configuration, pas une
-- constante du code. Une personne nommée ne doit jamais être écrite en dur :
-- elle est destinataire parce qu'elle porte un rôle, ou parce qu'un
-- administrateur l'a explicitement désignée — et cela se change sans livraison.
CREATE TABLE IF NOT EXISTS public.notification_routing (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  topic text NOT NULL,
  role_key text NULL REFERENCES public.app_roles(role_key) ON UPDATE CASCADE ON DELETE CASCADE,
  user_id integer NULL REFERENCES public.users(id) ON DELETE CASCADE,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by integer NULL REFERENCES public.users(id) ON DELETE SET NULL,
  CONSTRAINT notification_routing_target_ck CHECK (
    (role_key IS NOT NULL AND user_id IS NULL) OR (role_key IS NULL AND user_id IS NOT NULL)
  ),
  CONSTRAINT notification_routing_topic_ck CHECK (btrim(topic) <> '')
);

CREATE UNIQUE INDEX IF NOT EXISTS notification_routing_role_uq
  ON public.notification_routing(topic, role_key)
  WHERE role_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS notification_routing_user_uq
  ON public.notification_routing(topic, user_id)
  WHERE user_id IS NOT NULL;

COMMENT ON TABLE public.notification_routing IS
  'Destinataires par sujet de notification, par rôle ou par identité désignée. Aucune identité n''est codée en dur côté application.';

-- Amorçage par rôle uniquement. Les rôles existent déjà (#315) ; aucune personne
-- n'est nommée ici.
DO $$
BEGIN
  IF to_regclass('public.app_roles') IS NULL THEN
    RAISE NOTICE 'app_roles absent : amorçage du routage de notification ignoré';
    RETURN;
  END IF;

  INSERT INTO public.notification_routing (topic, role_key)
  SELECT t.topic, r.role_key
  FROM (VALUES
    -- Dérive de temps : le planificateur arbitre la replanification.
    ('OF_TIME_VARIANCE', ARRAY['Planning', 'Planification', 'Responsable Atelier-Production']),
    -- Planning soumis à validation.
    ('OF_PLANNING_SUBMITTED', ARRAY['Planning', 'Planification', 'Responsable Atelier-Production']),
    -- AR à recaler : l'administration des ventes reprend contact avec le client.
    ('AR_RECALAGE', ARRAY['Commerce', 'Assistante polyvalente', 'Secretaire'])
  ) AS t(topic, roles)
  CROSS JOIN LATERAL unnest(t.roles) AS r(role_key)
  WHERE EXISTS (SELECT 1 FROM public.app_roles a WHERE a.role_key = r.role_key)
  ON CONFLICT DO NOTHING;
END $$;

/* ========================================================================== */
/* E) DOCUMENT D'OF FIGÉ                                                      */
/* ========================================================================== */

-- L'aperçu écran et le PDF serveur consomment le MÊME payload. Le payload est
-- figé ici : une réimpression rejoue l'instantané et reproduit octet pour octet
-- le même binaire, donc la même empreinte.
CREATE TABLE IF NOT EXISTS public.of_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  of_id bigint NOT NULL REFERENCES public.ordres_fabrication(id) ON DELETE RESTRICT,
  revision_id uuid NOT NULL REFERENCES public.of_revisions(id) ON DELETE RESTRICT,

  -- Instantané de rendu : tout ce que le document affiche, et rien d'autre.
  payload jsonb NOT NULL,
  payload_sha256 text NOT NULL,

  -- Empreinte du binaire produit. Une réimpression qui changerait ce hash est un défaut.
  pdf_sha256 text NULL,
  pdf_byte_size integer NULL,

  -- Horodatage de génération, figé : il entre dans le binaire (métadonnées PDF).
  generated_at timestamptz NOT NULL DEFAULT now(),
  generated_by integer NULL REFERENCES public.users(id) ON DELETE SET NULL,
  generated_by_label text NULL,

  statut text NOT NULL DEFAULT 'OFFICIEL',

  -- Versement GED (ADR-0037).
  ged_document_id uuid NULL,
  ged_version_id uuid NULL,

  reprint_count integer NOT NULL DEFAULT 0,
  last_reprinted_at timestamptz NULL,

  idempotency_key text NULL,

  CONSTRAINT of_documents_payload_sha256_ck CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
  CONSTRAINT of_documents_pdf_sha256_ck CHECK (pdf_sha256 IS NULL OR pdf_sha256 ~ '^[a-f0-9]{64}$'),
  CONSTRAINT of_documents_statut_ck CHECK (statut IN ('BROUILLON', 'OFFICIEL', 'OBSOLETE')),
  CONSTRAINT of_documents_reprint_ck CHECK (reprint_count >= 0)
);

-- Un document officiel par révision : c'est la pièce qui accompagne la
-- fabrication. Les brouillons, eux, peuvent coexister.
CREATE UNIQUE INDEX IF NOT EXISTS of_documents_official_uq
  ON public.of_documents(revision_id)
  WHERE statut = 'OFFICIEL';

CREATE UNIQUE INDEX IF NOT EXISTS of_documents_idempotency_uq
  ON public.of_documents(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS of_documents_of_idx
  ON public.of_documents(of_id, generated_at DESC);

COMMENT ON TABLE public.of_documents IS
  'Document d''OF figé : payload immuable partagé par l''aperçu et le PDF, empreinte du binaire, versement GED.';

-- Le payload et l'horodatage sont immuables : ce sont eux qui garantissent
-- qu'une réimpression reproduit le même binaire. Seuls le compteur de
-- réimpression, le statut et le lien GED évoluent.
CREATE OR REPLACE FUNCTION public.fn_of_documents_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Un document d''OF ne se supprime pas : il devient OBSOLETE'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.of_id IS DISTINCT FROM OLD.of_id
     OR NEW.revision_id IS DISTINCT FROM OLD.revision_id
     OR NEW.payload IS DISTINCT FROM OLD.payload
     OR NEW.payload_sha256 IS DISTINCT FROM OLD.payload_sha256
     OR NEW.generated_at IS DISTINCT FROM OLD.generated_at
     OR NEW.generated_by_label IS DISTINCT FROM OLD.generated_by_label THEN
    RAISE EXCEPTION 'Le payload et l''horodatage d''un document d''OF sont immuables'
      USING ERRCODE = '55000';
  END IF;
  -- L'empreinte du binaire ne s'écrit qu'une fois.
  IF OLD.pdf_sha256 IS NOT NULL AND NEW.pdf_sha256 IS DISTINCT FROM OLD.pdf_sha256 THEN
    RAISE EXCEPTION 'L''empreinte PDF d''un document d''OF est immuable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_of_documents_immutable ON public.of_documents;
CREATE TRIGGER trg_of_documents_immutable
  BEFORE UPDATE OR DELETE ON public.of_documents
  FOR EACH ROW EXECUTE FUNCTION public.fn_of_documents_immutable();

/* ========================================================================== */
/* F) RACCORD AU RÉFÉRENTIEL DES FAMILLES MACHINE                             */
/* ========================================================================== */

-- La famille d'une phase n'est plus une constante du code : c'est une ligne de
-- `production_machine_families`, administrable par les Méthodes. Ce chantier la
-- CONSOMME, il ne la redéfinit pas — sinon un ajout de famille exigerait une
-- livraison applicative, ce que la normalisation des gammes vient précisément
-- d'éliminer.
DO $$
BEGIN
  IF to_regclass('public.production_machine_families') IS NULL THEN
    RAISE EXCEPTION 'Prérequis manquant : 20260729_methodes_gamme_referentials.sql doit être appliqué avant ce patch';
  END IF;

  -- `DECOUPE` est indispensable au document d'OF : une phase de débit sans
  -- famille sortirait du PDF sans centre affecté.
  IF NOT EXISTS (SELECT 1 FROM public.production_machine_families WHERE code = 'DECOUPE') THEN
    RAISE EXCEPTION 'Référentiel incomplet : la famille DECOUPE est requise par le document d''OF';
  END IF;
END $$;

-- Le document d'OF et le diff de révision groupent les phases par famille : sans
-- cet index, chaque rendu balaie la table des opérations.
CREATE INDEX IF NOT EXISTS of_operations_family_idx
  ON public.of_operations (machine_family_code)
  WHERE machine_family_code IS NOT NULL;

-- Un n° de programme vide n'est pas un n° de programme. La donnée manquante doit
-- rester NULL pour que le document la SIGNALE au lieu de l'afficher en blanc
-- (critère d'acceptation #370 : une donnée absente est signalée, jamais inventée).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'of_operations_programme_ck' AND conrelid = 'public.of_operations'::regclass
  ) THEN
    ALTER TABLE public.of_operations
      ADD CONSTRAINT of_operations_programme_ck
      CHECK (numero_programme IS NULL OR btrim(numero_programme) <> '');
  END IF;
END $$;

COMMENT ON COLUMN public.of_operations.machine_family_code IS
  'Famille machine figée au lancement, clé de public.production_machine_families. Volontairement SANS clé étrangère : un snapshot d''OF est une preuve, une famille renommée ne doit pas la casser.';

/* ========================================================================== */
/* G) PROPRIÉTÉ DES OBJETS APPLICATIFS                                        */
/* ========================================================================== */

-- Appliqué via `sudo -u postgres`, tout objet créé appartient à `postgres` et
-- `cerp_app` se prend un `permission denied` (42501) → l'endpoint répond 500 alors
-- que le schéma est correct. Ce bloc rend la propriété au rôle applicatif.
-- `erp_audit_logs` et `hr_time_events` restent volontairement à `postgres`
-- (append-only ISO) et ne sont pas touchés ici.
DO $$
DECLARE
  v_obj text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app') THEN
    RAISE NOTICE 'Rôle cerp_app absent : réattribution de propriété ignorée';
    RETURN;
  END IF;

  FOREACH v_obj IN ARRAY ARRAY[
    'of_revisions',
    'of_operation_visas',
    'of_time_variance_proposals',
    'of_planning_versions',
    'ar_recalage_dossiers',
    'notification_routing',
    'of_documents'
  ] LOOP
    IF to_regclass('public.' || v_obj) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I OWNER TO cerp_app', v_obj);
    END IF;
  END LOOP;
END $$;

COMMIT;
