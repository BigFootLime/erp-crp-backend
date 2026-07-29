-- 20260729_piece_technique_document_policy_227.sql
-- Issue back #227 / front #375 — Politique documentaire Client -> Pièce technique.
--
-- POURQUOI CE PATCH
-- L'exigence documentaire d'un client était portée par public.documents_fournir, trois
-- booléens plats (certificat_mp, certificat_traitement, value_report) sans granularité par
-- pièce, sans motif et sans gel. On remplace ce modèle par un contrat explicite :
--   * une POLITIQUE nommée sur le client (NONE / REQUIRED_FOR_ALL_LINKED_PT / PER_PT_CRITICAL),
--   * un RÉFÉRENTIEL de types de documents configurable (et non une liste en dur),
--   * une sélection de types par client,
--   * un attribut « pièce critique » sur la pièce technique,
--   * un INSTANTANÉ figé sur la version publiée, pour qu'une modification ultérieure du
--     client ne réécrive jamais une version déjà publiée.
--
-- NON DESTRUCTIF — public.documents_fournir et public.clients.provided_documents_id sont
-- CONSERVÉS tels quels. Constat de production le 2026-07-29 : documents_fournir compte
-- 0 ligne sur cerp_test ET cerp_prod, et aucun client ne la référence — aucune donnée
-- existante n'est donc réinterprétée, déplacée ni supprimée par ce patch.
--
-- Additif, idempotent, sans DROP/DELETE/UPDATE de données existantes.
-- Rôle applicatif : cerp_app (voir étape 9 pour l'attribution de propriété).
--
-- Scripts de support (à lancer à la main, NON pris par db:patches:up) :
--   db/patches/support/20260729_piece_technique_document_policy_227.preflight.sql
--   db/patches/support/20260729_piece_technique_document_policy_227.verify.sql
--   db/patches/support/20260729_piece_technique_document_policy_227.rollback.sql

BEGIN;

/* -------------------------------------------------------------------------- */
/* 0) Gardes : les tables maîtresses doivent exister                          */
/* -------------------------------------------------------------------------- */

DO $$
BEGIN
  IF to_regclass('public.clients') IS NULL THEN
    RAISE EXCEPTION '#227: public.clients est absente';
  END IF;
  IF to_regclass('public.pieces_techniques') IS NULL THEN
    RAISE EXCEPTION '#227: public.pieces_techniques est absente';
  END IF;
  IF to_regclass('public.piece_technique_versions') IS NULL THEN
    RAISE EXCEPTION '#227: public.piece_technique_versions est absente — appliquer 20260707_pieces_techniques_gpao_versions_gammes.sql';
  END IF;
END $$;

/* -------------------------------------------------------------------------- */
/* 1) Référentiel des types de documents exigibles                            */
/*    Configurable : `is_system` protège les six types fondateurs de la        */
/*    désactivation accidentelle, sans interdire d'en ajouter d'autres.        */
/* -------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS public.piece_document_types (
  code           text PRIMARY KEY,
  label          text        NOT NULL,
  description    text,
  -- Classe GED correspondante quand elle existe : permet de retrouver un document
  -- déjà classé au coffre sans dupliquer le référentiel de stockage.
  ged_class_key  text,
  is_system      boolean     NOT NULL DEFAULT false,
  is_active      boolean     NOT NULL DEFAULT true,
  sort_order     integer     NOT NULL DEFAULT 100,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  created_by     integer,
  updated_by     integer
);

ALTER TABLE public.piece_document_types
  ADD COLUMN IF NOT EXISTS ged_class_key text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'piece_document_types_code_format_chk') THEN
    ALTER TABLE public.piece_document_types
      ADD CONSTRAINT piece_document_types_code_format_chk
      CHECK (code ~ '^[A-Z][A-Z0-9_]{1,49}$');
  END IF;
END $$;

-- FK optionnelle vers le référentiel GED : posée seulement si la table existe, et
-- ON DELETE SET NULL pour qu'une réorganisation du coffre ne bloque jamais l'exigence.
DO $$
BEGIN
  IF to_regclass('public.ged_document_classes') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'piece_document_types_ged_class_fkey') THEN
    ALTER TABLE public.piece_document_types
      ADD CONSTRAINT piece_document_types_ged_class_fkey
      FOREIGN KEY (ged_class_key) REFERENCES public.ged_document_classes (class_key)
      ON UPDATE CASCADE ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS piece_document_types_active_227_idx
  ON public.piece_document_types (is_active, sort_order, code);

-- Amorçage des six types fondateurs. ON CONFLICT DO NOTHING : ré-exécuter le patch
-- n'écrase jamais un libellé qu'un administrateur aurait ajusté.
INSERT INTO public.piece_document_types (code, label, description, ged_class_key, is_system, is_active, sort_order)
VALUES
  ('PLAN',                'Plan',                        'Plan de définition client de la pièce, à l''indice applicable.',        'PLAN_CLIENT',     true, true, 10),
  ('CERTIF_MATIERE',      'Certificat matière',          'Certificat matière de la coulée employée (EN 10204 3.1 ou équivalent).', 'CERTIF_MATIERE',  true, true, 20),
  ('CC_CCPU',             'CC / CCPU',                   'Certificat de conformité, éventuellement par unité de production.',      NULL,              true, true, 30),
  ('BL_CERTIFIE',         'BL certifié',                 'Bon de livraison certifié accompagnant l''expédition.',                  NULL,              true, true, 40),
  ('CERTIF_TRAITEMENT',   'Certificat de traitement',    'Certificat du traitement thermique ou de surface appliqué.',             NULL,              true, true, 50),
  ('RAPPORT_CONTROLE',    'Rapport de contrôle / PV',    'Rapport de contrôle dimensionnel ou procès-verbal de réception.',        'RELEVE_CONTROLE', true, true, 60)
ON CONFLICT (code) DO NOTHING;

-- Rattrapage du lien GED sur une base où les types existaient déjà sans classe :
-- on ne renseigne QUE les valeurs nulles, aucun choix humain n'est écrasé.
-- EXECUTE dynamique : la requête ne doit pas être analysée quand la table GED est absente.
DO $$
BEGIN
  IF to_regclass('public.ged_document_classes') IS NOT NULL THEN
    EXECUTE $sql$
      UPDATE public.piece_document_types t
         SET ged_class_key = v.class_key,
             updated_at    = now()
        FROM (VALUES
               ('PLAN',             'PLAN_CLIENT'),
               ('CERTIF_MATIERE',   'CERTIF_MATIERE'),
               ('RAPPORT_CONTROLE', 'RELEVE_CONTROLE')
             ) AS v(code, class_key)
       WHERE t.code = v.code
         AND t.ged_class_key IS NULL
         AND EXISTS (SELECT 1 FROM public.ged_document_classes g WHERE g.class_key = v.class_key)
    $sql$;
  END IF;
END $$;

/* -------------------------------------------------------------------------- */
/* 2) Politique documentaire portée par le client                             */
/*    Trois valeurs nommées — jamais un booléen « documents complets ».        */
/* -------------------------------------------------------------------------- */

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS document_policy text NOT NULL DEFAULT 'NONE';

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS document_policy_updated_at timestamptz;

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS document_policy_updated_by integer;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'clients_document_policy_chk') THEN
    ALTER TABLE public.clients
      ADD CONSTRAINT clients_document_policy_chk
      CHECK (document_policy IN ('NONE', 'REQUIRED_FOR_ALL_LINKED_PT', 'PER_PT_CRITICAL'));
  END IF;
END $$;

/* -------------------------------------------------------------------------- */
/* 3) Types de documents retenus pour un client                               */
/*    Vide = le client exige tous les types actifs du référentiel ; une        */
/*    sélection explicite restreint. Le moteur applicatif porte cette règle.   */
/* -------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS public.client_document_requirements (
  client_id          varchar(3)  NOT NULL,
  document_type_code text        NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         integer,
  CONSTRAINT client_document_requirements_pkey PRIMARY KEY (client_id, document_type_code)
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'client_document_requirements_client_fkey') THEN
    ALTER TABLE public.client_document_requirements
      ADD CONSTRAINT client_document_requirements_client_fkey
      FOREIGN KEY (client_id) REFERENCES public.clients (client_id)
      ON UPDATE CASCADE ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'client_document_requirements_type_fkey') THEN
    ALTER TABLE public.client_document_requirements
      ADD CONSTRAINT client_document_requirements_type_fkey
      FOREIGN KEY (document_type_code) REFERENCES public.piece_document_types (code)
      ON UPDATE CASCADE ON DELETE RESTRICT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS client_document_requirements_client_227_idx
  ON public.client_document_requirements (client_id);

/* -------------------------------------------------------------------------- */
/* 4) Attribut « pièce critique » sur la pièce technique                      */
/*    Ne sert QUE sous la politique PER_PT_CRITICAL — le moteur l'ignore       */
/*    sous les deux autres politiques.                                        */
/* -------------------------------------------------------------------------- */

ALTER TABLE public.pieces_techniques
  ADD COLUMN IF NOT EXISTS piece_critique boolean NOT NULL DEFAULT false;

ALTER TABLE public.pieces_techniques
  ADD COLUMN IF NOT EXISTS piece_critique_motif text;

CREATE INDEX IF NOT EXISTS pieces_techniques_critique_227_idx
  ON public.pieces_techniques (piece_critique)
  WHERE piece_critique = true;

/* -------------------------------------------------------------------------- */
/* 5) Instantané figé des exigences sur une version de pièce                  */
/*    C'est le GEL demandé : la ligne porte le motif ET la politique en        */
/*    vigueur au moment du gel. Rien ici n'est recalculé ensuite.             */
/* -------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS public.piece_version_document_requirements (
  id                        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  piece_technique_version_id uuid       NOT NULL,
  document_type_code        text        NOT NULL,
  -- Libellé recopié : le référentiel peut être renommé sans réécrire l'histoire.
  document_type_label       text        NOT NULL,
  policy                    text        NOT NULL,
  piece_critique            boolean     NOT NULL DEFAULT false,
  reason_code               text        NOT NULL,
  reason_label              text        NOT NULL,
  frozen_at                 timestamptz NOT NULL DEFAULT now(),
  frozen_by                 integer,
  CONSTRAINT piece_version_document_requirements_uq
    UNIQUE (piece_technique_version_id, document_type_code)
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'piece_version_document_requirements_version_fkey') THEN
    ALTER TABLE public.piece_version_document_requirements
      ADD CONSTRAINT piece_version_document_requirements_version_fkey
      FOREIGN KEY (piece_technique_version_id) REFERENCES public.piece_technique_versions (id)
      ON UPDATE CASCADE ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'piece_version_document_requirements_policy_chk') THEN
    ALTER TABLE public.piece_version_document_requirements
      ADD CONSTRAINT piece_version_document_requirements_policy_chk
      CHECK (policy IN ('NONE', 'REQUIRED_FOR_ALL_LINKED_PT', 'PER_PT_CRITICAL'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS piece_version_document_requirements_version_227_idx
  ON public.piece_version_document_requirements (piece_technique_version_id);

-- Horodatage du gel porté par la version elle-même : distingue « version publiée sans
-- exigence » (gel fait, zéro ligne) de « version jamais gelée » (colonne nulle).
ALTER TABLE public.piece_technique_versions
  ADD COLUMN IF NOT EXISTS document_requirements_frozen_at timestamptz;

ALTER TABLE public.piece_technique_versions
  ADD COLUMN IF NOT EXISTS document_requirements_policy text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'piece_technique_versions_doc_policy_chk') THEN
    ALTER TABLE public.piece_technique_versions
      ADD CONSTRAINT piece_technique_versions_doc_policy_chk
      CHECK (document_requirements_policy IS NULL
             OR document_requirements_policy IN ('NONE', 'REQUIRED_FOR_ALL_LINKED_PT', 'PER_PT_CRITICAL'));
  END IF;
END $$;

/* -------------------------------------------------------------------------- */
/* 6) Rattachement d'un document de pièce à un type du référentiel            */
/*    Additif sur la table de documents existante : aucun document n'est       */
/*    déplacé, seuls les nouveaux dépôts peuvent être typés.                  */
/* -------------------------------------------------------------------------- */

ALTER TABLE public.pieces_techniques_documents
  ADD COLUMN IF NOT EXISTS document_type_code text;

ALTER TABLE public.pieces_techniques_documents
  ADD COLUMN IF NOT EXISTS piece_technique_version_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pieces_techniques_documents_type_fkey') THEN
    ALTER TABLE public.pieces_techniques_documents
      ADD CONSTRAINT pieces_techniques_documents_type_fkey
      FOREIGN KEY (document_type_code) REFERENCES public.piece_document_types (code)
      ON UPDATE CASCADE ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pieces_techniques_documents_version_fkey') THEN
    ALTER TABLE public.pieces_techniques_documents
      ADD CONSTRAINT pieces_techniques_documents_version_fkey
      FOREIGN KEY (piece_technique_version_id) REFERENCES public.piece_technique_versions (id)
      ON UPDATE CASCADE ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS pieces_techniques_documents_type_227_idx
  ON public.pieces_techniques_documents (piece_technique_id, document_type_code)
  WHERE removed_at IS NULL;

/* -------------------------------------------------------------------------- */
/* 7) Brouillon de création de pièce technique (sauvegarde / reprise)         */
/*    Le brouillon est PRIVÉ à son auteur : la reprise ne traverse jamais un   */
/*    compte, et la charge utile reste du JSON opaque côté base.              */
/* -------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS public.piece_technique_create_drafts (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id       integer     NOT NULL,
  title               text,
  payload             jsonb       NOT NULL DEFAULT '{}'::jsonb,
  current_step        text,
  piece_technique_id  uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  submitted_at        timestamptz,
  abandoned_at        timestamptz
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'piece_technique_create_drafts_piece_fkey') THEN
    ALTER TABLE public.piece_technique_create_drafts
      ADD CONSTRAINT piece_technique_create_drafts_piece_fkey
      FOREIGN KEY (piece_technique_id) REFERENCES public.pieces_techniques (id)
      ON UPDATE CASCADE ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS piece_technique_create_drafts_owner_227_idx
  ON public.piece_technique_create_drafts (owner_user_id, updated_at DESC)
  WHERE submitted_at IS NULL AND abandoned_at IS NULL;

/* -------------------------------------------------------------------------- */
/* 8) Idempotence de création de pièce technique                              */
/*    Même forme que public.client_create_idempotency et que la table du       */
/*    chantier #167 (piece_technique_create_idempotence) : le CREATE IF NOT    */
/*    EXISTS converge quel que soit l'ordre de fusion des deux branches.       */
/* -------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS public.piece_technique_create_idempotence (
  idempotency_key    text        PRIMARY KEY,
  request_hash       char(64)    NOT NULL,
  piece_technique_id uuid        NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS piece_technique_create_idempotence_piece_227_idx
  ON public.piece_technique_create_idempotence (piece_technique_id);

/* -------------------------------------------------------------------------- */
/* 9) Propriété des objets applicatifs                                        */
/*    Créés sous peer auth `postgres`, ils appartiendraient à postgres et      */
/*    cerp_app recevrait 42501 -> 500. On rétablit la propriété applicative.   */
/* -------------------------------------------------------------------------- */

DO $$
DECLARE
  t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app') THEN
    FOREACH t IN ARRAY ARRAY[
      'public.piece_document_types',
      'public.client_document_requirements',
      'public.piece_version_document_requirements',
      'public.piece_technique_create_drafts',
      'public.piece_technique_create_idempotence'
    ] LOOP
      IF to_regclass(t) IS NOT NULL THEN
        EXECUTE format('ALTER TABLE %s OWNER TO cerp_app', t);
      END IF;
    END LOOP;
  END IF;
END $$;

COMMIT;
