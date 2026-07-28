-- 20260728_surface_finish_library_210.sql
--
-- Bibliothèque de finitions et génération d'articles de sous-traitance (#210 / web #339).
-- ADR : crp-systems-web/docs/adr/ADR-0038-surface-finish-library.md
--
-- ADDITIF, IDEMPOTENT, NON DESTRUCTIF :
--   - 6 nouvelles tables (référentiel administrable, finitions, révisions, documents,
--     exigence d'opération, reçus d'idempotence) ;
--   - colonnes NULLABLES ajoutées à `articles_traitement` (spécialisation existante,
--     PK article_id) et à `pieces_techniques_achats` (liaison FK vers l'opération) ;
--   - élargissement du whitelist de `fn_next_issued_code_value` au scope `FIN`.
--   Aucune table existante n'est renommée, vidée, ni recodée. AUCUN BACKFILL :
--   l'historique reste tel quel, un rapport de candidats est fourni séparément
--   (db/patches/support/20260728_surface_finish_library_210.candidates.sql).
--
-- Pipeline db/patches (exécuté en tant que cerp_app). Cible : PostgreSQL 17.
--   Preflight : db/patches/support/20260728_surface_finish_library_210.preflight.sql
--   Verify    : db/patches/support/20260728_surface_finish_library_210.verify.sql
--   Rollback  : db/patches/support/20260728_surface_finish_library_210.rollback.sql

BEGIN;

/* -------------------------------------------------------------------------- */
/* 0) Pré-requis structurels                                                  */
/* -------------------------------------------------------------------------- */

DO $$
BEGIN
  IF to_regclass('public.gammes') IS NULL THEN
    RAISE EXCEPTION '#210: public.gammes is missing — apply 20260707_pieces_techniques_gpao_versions_gammes.sql first';
  END IF;
  IF to_regclass('public.articles_traitement') IS NULL THEN
    RAISE EXCEPTION '#210: public.articles_traitement is missing — apply 20260319_articles_domain_subtypes.sql first';
  END IF;
  IF to_regprocedure('public.fn_next_issued_code_value(text)') IS NULL THEN
    RAISE EXCEPTION '#210: public.fn_next_issued_code_value(text) is missing — apply 20260713_codification_versions_of_vsm.sql first';
  END IF;
END $$;

/* -------------------------------------------------------------------------- */
/* 1) Codification : le scope FIN rejoint le whitelist                        */
/* -------------------------------------------------------------------------- */
-- Corps identique à 20260726_metrologie_360_229.sql, le whitelist gagne `FIN`.
-- Aucun scope existant n'est retiré (MCH et MET restent, cf. régression 20260725).

CREATE OR REPLACE FUNCTION public.fn_next_issued_code_value(p_scope text)
RETURNS bigint
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
  v_scope text := upper(btrim(COALESCE(p_scope, '')));
BEGIN
  IF v_scope !~ '^(CLI|FOU|MCH|MET|FIN|ART:[A-Z0-9]{1,48}|(DEV|CMD|AFF|OF|LOT|MVT|CQ|NC|CAPA|BL|FACT|BCF|PC|DER|MEX|MIA):[0-9]{4})$' THEN
    RAISE EXCEPTION 'Unsupported business-code sequence scope: %', p_scope
      USING ERRCODE = '22023';
  END IF;
  RETURN nextval('public.cerp_business_code_issue_seq'::regclass);
END;
$$;

COMMENT ON FUNCTION public.fn_next_issued_code_value(text) IS
  'Whitelisted, non-reusable business-code allocator backed by a native PostgreSQL sequence. Scopes: CLI, FOU, MCH, MET, FIN, ART:<FAMILY>, <PREFIX>:<YEAR>.';

/* -------------------------------------------------------------------------- */
/* 1bis) Fonctions utilitaires immuables (recherche et unités)                 */
/* -------------------------------------------------------------------------- */
-- `unaccent` n'est pas garanti installé sur toutes les bases CERP : on
-- normalise avec `translate`, qui est natif, immuable et indexable.

CREATE OR REPLACE FUNCTION public.surface_finish_norm(p_value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT lower(translate(
    COALESCE(p_value, ''),
    'ÀÁÂÃÄÅàáâãäåÈÉÊËèéêëÌÍÎÏìíîïÒÓÔÕÖØòóôõöøÙÚÛÜùúûüÇçÑñŸÿ',
    'AAAAAAaaaaaaEEEEeeeeIIIIiiiiOOOOOOooooooUUUUuuuuCcNnYy'
  ))
$$;

COMMENT ON FUNCTION public.surface_finish_norm(text) IS
  '#210 — Normalisation de recherche (minuscules + accents neutralisés), sans dépendre de l''extension unaccent.';

-- Conversion vers le micromètre, unité pivot des épaisseurs de revêtement.
-- Miroir EXACT de `thicknessToMicrometers` côté TypeScript.
CREATE OR REPLACE FUNCTION public.surface_finish_to_um(p_value numeric, p_unit text)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE lower(btrim(COALESCE(p_unit, 'um')))
    WHEN 'um'  THEN p_value
    WHEN 'mm'  THEN p_value * 1000
    WHEN 'cm'  THEN p_value * 10000
    WHEN 'in'  THEN p_value * 25400
    WHEN 'mil' THEN p_value * 25.4
    ELSE NULL
  END
$$;

COMMENT ON FUNCTION public.surface_finish_to_um(numeric, text) IS
  '#210 — Épaisseur normalisée en micromètres. Miroir de thicknessToMicrometers (surface-finish-policy.ts).';

/* -------------------------------------------------------------------------- */
/* 2) Familles de finitions — référentiel ADMINISTRABLE (jamais un enum)      */
/* -------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS public.surface_finish_families (
  code            text PRIMARY KEY,
  label           text NOT NULL,
  description     text NULL,
  sort_order      integer NOT NULL DEFAULT 100,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT surface_finish_families_code_not_blank CHECK (btrim(code) <> ''),
  CONSTRAINT surface_finish_families_label_not_blank CHECK (btrim(label) <> '')
);

COMMENT ON TABLE public.surface_finish_families IS
  '#210 — Familles de finitions administrables. Ajouter une famille est un acte de paramétrage, pas une migration.';

-- Amorçage : familles couramment employées chez CRP. `ON CONFLICT DO NOTHING`
-- pour ne jamais écraser un libellé ajusté par le métier après coup.
INSERT INTO public.surface_finish_families (code, label, description, sort_order) VALUES
  ('ANODISATION',        'Anodisation',                    'Oxydation anodique décorative ou protectrice de l''aluminium.', 10),
  ('ANODISATION_DURE',   'Anodisation dure',               'Oxydation anodique dure, forte épaisseur et dureté.',           20),
  ('PASSIVATION',        'Passivation',                    'Passivation des aciers inoxydables et alliages.',               30),
  ('ZINGAGE',            'Zingage',                        'Revêtement électrolytique de zinc et alliages de zinc.',        40),
  ('NICKELAGE_CHIMIQUE', 'Nickelage chimique',             'Dépôt autocatalytique de nickel-phosphore.',                    50),
  ('CHROMAGE',           'Chromage',                       'Dépôt électrolytique de chrome, dur ou décoratif.',             60),
  ('BRUNISSAGE',         'Brunissage',                     'Oxydation noire des aciers.',                                   70),
  ('PHOSPHATATION',      'Phosphatation',                  'Conversion phosphatante, zinc ou manganèse.',                   80),
  ('PEINTURE',           'Peinture',                       'Peinture liquide, primaire et finition.',                       90),
  ('THERMOLAQUAGE',      'Thermolaquage',                  'Poudre polymérisée au four.',                                  100),
  ('CATAPHORESE',        'Cataphorèse',                    'Électrodéposition cathodique.',                                110),
  ('PREPARATION_SURFACE','Préparation / finition mécanique','Sablage, grenaillage, polissage, tribofinition, ébavurage.',   120),
  ('AUTRE',              'Autre procédé validé',           'Procédé validé hors familles listées.',                        900)
ON CONFLICT (code) DO NOTHING;

/* -------------------------------------------------------------------------- */
/* 3) Finitions — définition maître (identité)                                */
/* -------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS public.surface_finishes (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                text NOT NULL,
  family_code         text NOT NULL,
  procede             text NOT NULL,
  designation_courte  text NOT NULL,
  designation_longue  text NULL,
  description         text NULL,
  synonymes           text[] NOT NULL DEFAULT ARRAY[]::text[],
  statut              text NOT NULL DEFAULT 'BROUILLON',
  current_revision_id uuid NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  created_by          integer NULL,
  updated_by          integer NULL,
  CONSTRAINT surface_finishes_code_uq UNIQUE (code),
  CONSTRAINT surface_finishes_code_format CHECK (code ~ '^FIN-[0-9]{6}$'),
  CONSTRAINT surface_finishes_designation_not_blank CHECK (btrim(designation_courte) <> ''),
  CONSTRAINT surface_finishes_procede_not_blank CHECK (btrim(procede) <> ''),
  CONSTRAINT surface_finishes_statut_check CHECK (
    statut IN ('BROUILLON','EN_VALIDATION','ACTIVE','SUSPENDUE','OBSOLETE','ARCHIVEE')
  ),
  CONSTRAINT surface_finishes_family_fk FOREIGN KEY (family_code)
    REFERENCES public.surface_finish_families(code) ON DELETE RESTRICT
);

COMMENT ON TABLE public.surface_finishes IS
  '#210 — Définition maître d''un procédé de finition. Le code FIN-NNNNNN est alloué par le serveur et immuable.';
COMMENT ON COLUMN public.surface_finishes.synonymes IS
  'Synonymes de recherche saisis par le métier (« alu noir », « OAD »…). Sert à la recherche, jamais à l''identité.';

CREATE INDEX IF NOT EXISTS surface_finishes_family_idx ON public.surface_finishes (family_code);
CREATE INDEX IF NOT EXISTS surface_finishes_statut_idx ON public.surface_finishes (statut);
-- Index alignés sur les prédicats réels de la recherche (`surface_finish_norm`).
CREATE INDEX IF NOT EXISTS surface_finishes_code_norm_idx
  ON public.surface_finishes (public.surface_finish_norm(code));
CREATE INDEX IF NOT EXISTS surface_finishes_designation_norm_idx
  ON public.surface_finishes (public.surface_finish_norm(designation_courte));
CREATE INDEX IF NOT EXISTS surface_finishes_procede_norm_idx
  ON public.surface_finishes (public.surface_finish_norm(procede));
CREATE INDEX IF NOT EXISTS surface_finishes_synonymes_gin_idx ON public.surface_finishes USING gin (synonymes);

/* -------------------------------------------------------------------------- */
/* 4) Révisions — la définition technique VERSIONNÉE                          */
/* -------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS public.surface_finish_revisions (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  finish_id               uuid NOT NULL,
  revision                integer NOT NULL,
  statut                  text NOT NULL DEFAULT 'BROUILLON',

  -- Référence normative : CERP stocke la RÉFÉRENCE et les paramètres validés
  -- par CRP. Aucun contenu protégé de norme n'est recopié ici.
  norme                   text NULL,
  reference_client        text NULL,
  classe                  text NULL,
  substrat                text NULL,

  epaisseur_min           numeric NULL,
  epaisseur_nominale      numeric NULL,
  epaisseur_max           numeric NULL,
  epaisseur_unite         text NOT NULL DEFAULT 'um',

  couleur                 text NULL,
  teinte_ral              text NULL,
  aspect                  text NULL,
  brillance               text NULL,
  rugosite                text NULL,
  durete                  text NULL,
  exigence_corrosion      text NULL,

  pretraitement           text NULL,
  posttraitement          text NULL,
  zones_defaut            text[] NOT NULL DEFAULT ARRAY[]::text[],
  regles_masquage         text[] NOT NULL DEFAULT ARRAY[]::text[],

  criteres_acceptation    text NULL,
  controles               text[] NOT NULL DEFAULT ARRAY[]::text[],
  certificat_requis       boolean NOT NULL DEFAULT false,
  certificat_type         text NULL,
  conditionnement_retour  text NULL,
  unite_achat             text NOT NULL DEFAULT 'PCE',

  designation_template    text NULL,
  commentaire_template    text NULL,
  template_version        integer NOT NULL DEFAULT 1,

  date_effet              date NULL,
  approbateur_user_id     integer NULL,
  approved_at             timestamptz NULL,

  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  created_by              integer NULL,
  updated_by              integer NULL,

  CONSTRAINT surface_finish_revisions_finish_fk FOREIGN KEY (finish_id)
    REFERENCES public.surface_finishes(id) ON DELETE CASCADE,
  CONSTRAINT surface_finish_revisions_finish_rev_uq UNIQUE (finish_id, revision),
  CONSTRAINT surface_finish_revisions_revision_positive CHECK (revision >= 1),
  CONSTRAINT surface_finish_revisions_statut_check CHECK (
    statut IN ('BROUILLON','EN_VALIDATION','ACTIVE','SUSPENDUE','OBSOLETE','ARCHIVEE')
  ),
  CONSTRAINT surface_finish_revisions_unite_check CHECK (
    epaisseur_unite IN ('um','mm','cm','in','mil')
  ),
  CONSTRAINT surface_finish_revisions_epaisseur_positive CHECK (
    (epaisseur_min IS NULL OR epaisseur_min >= 0)
    AND (epaisseur_nominale IS NULL OR epaisseur_nominale >= 0)
    AND (epaisseur_max IS NULL OR epaisseur_max >= 0)
  ),
  CONSTRAINT surface_finish_revisions_epaisseur_coherente CHECK (
    (epaisseur_min IS NULL OR epaisseur_max IS NULL OR epaisseur_min <= epaisseur_max)
    AND (epaisseur_nominale IS NULL OR epaisseur_min IS NULL OR epaisseur_nominale >= epaisseur_min)
    AND (epaisseur_nominale IS NULL OR epaisseur_max IS NULL OR epaisseur_nominale <= epaisseur_max)
  ),
  -- Un certificat exigé sans type est une exigence incomplète.
  CONSTRAINT surface_finish_revisions_certificat_coherent CHECK (
    certificat_requis = false OR btrim(COALESCE(certificat_type, '')) <> ''
  ),
  CONSTRAINT surface_finish_revisions_template_version_positive CHECK (template_version >= 1)
);

COMMENT ON TABLE public.surface_finish_revisions IS
  '#210 — Révision versionnée d''une finition : c''est ELLE qui porte la définition technique opposable.';
COMMENT ON COLUMN public.surface_finish_revisions.norme IS
  'Référence de la norme ou spécification (ex. « ISO 7599 »). Le texte de la norme n''est jamais recopié.';

CREATE INDEX IF NOT EXISTS surface_finish_revisions_finish_idx
  ON public.surface_finish_revisions (finish_id);
CREATE INDEX IF NOT EXISTS surface_finish_revisions_statut_idx
  ON public.surface_finish_revisions (statut);
CREATE INDEX IF NOT EXISTS surface_finish_revisions_norme_norm_idx
  ON public.surface_finish_revisions (public.surface_finish_norm(norme));
CREATE INDEX IF NOT EXISTS surface_finish_revisions_couleur_norm_idx
  ON public.surface_finish_revisions (public.surface_finish_norm(couleur));
CREATE INDEX IF NOT EXISTS surface_finish_revisions_ral_norm_idx
  ON public.surface_finish_revisions (public.surface_finish_norm(teinte_ral));

-- Une seule révision ACTIVE par finition : « la » révision applicable est non ambiguë.
CREATE UNIQUE INDEX IF NOT EXISTS surface_finish_revisions_single_active_uq
  ON public.surface_finish_revisions (finish_id)
  WHERE statut = 'ACTIVE';

-- Lien retour vers la révision courante (posé après création de la table cible).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'surface_finishes_current_revision_fk'
      AND conrelid = 'public.surface_finishes'::regclass
  ) THEN
    ALTER TABLE public.surface_finishes
      ADD CONSTRAINT surface_finishes_current_revision_fk
      FOREIGN KEY (current_revision_id)
      REFERENCES public.surface_finish_revisions(id) ON DELETE SET NULL;
  END IF;
END $$;

/* -------------------------------------------------------------------------- */
/* 5) Documents techniques d'une révision                                     */
/* -------------------------------------------------------------------------- */
-- Registre de RÉFÉRENCES documentaires. Le coffre est la GED centrale
-- (ADR-0037) : aucun chemin de stockage n'est stocké ni exposé ici.

CREATE TABLE IF NOT EXISTS public.surface_finish_revision_documents (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  revision_id         uuid NOT NULL,
  libelle             text NOT NULL,
  doc_type            text NOT NULL DEFAULT 'SPECIFICATION',
  ged_document_id     uuid NULL,
  reference_externe   text NULL,
  sha256              text NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          integer NULL,
  CONSTRAINT surface_finish_revision_documents_revision_fk FOREIGN KEY (revision_id)
    REFERENCES public.surface_finish_revisions(id) ON DELETE CASCADE,
  CONSTRAINT surface_finish_revision_documents_libelle_not_blank CHECK (btrim(libelle) <> ''),
  CONSTRAINT surface_finish_revision_documents_type_check CHECK (
    doc_type IN ('SPECIFICATION','NORME','FICHE_TECHNIQUE','PLAN_MASQUAGE','CERTIFICAT_TYPE','AUTRE')
  ),
  -- Un document sans aucune ancre (ni GED, ni référence externe) n'est pas un document.
  CONSTRAINT surface_finish_revision_documents_anchor_required CHECK (
    ged_document_id IS NOT NULL OR btrim(COALESCE(reference_externe, '')) <> ''
  ),
  CONSTRAINT surface_finish_revision_documents_sha_format CHECK (
    sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'
  )
);

COMMENT ON TABLE public.surface_finish_revision_documents IS
  '#210 — Références documentaires d''une révision. Le binaire vit dans la GED centrale ; aucun storage_path ici.';

CREATE INDEX IF NOT EXISTS surface_finish_revision_documents_revision_idx
  ON public.surface_finish_revision_documents (revision_id);

/* -------------------------------------------------------------------------- */
/* 6) Exigence de finition d'une opération de gamme                           */
/* -------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS public.gamme_operation_finitions (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gamme_id                      uuid NOT NULL,
  gamme_operation_id            uuid NOT NULL,
  piece_technique_version_id    uuid NOT NULL,
  finish_revision_id            uuid NOT NULL,

  perimetre                     text NOT NULL DEFAULT 'PIECE_ENTIERE',
  zones                         text[] NOT NULL DEFAULT ARRAY[]::text[],
  masquages                     text[] NOT NULL DEFAULT ARRAY[]::text[],

  norme                         text NULL,
  classe                        text NULL,
  epaisseur_min                 numeric NULL,
  epaisseur_nominale            numeric NULL,
  epaisseur_max                 numeric NULL,
  epaisseur_unite               text NOT NULL DEFAULT 'um',
  couleur                       text NULL,
  teinte_ral                    text NULL,
  aspect                        text NULL,
  rugosite                      text NULL,
  durete                        text NULL,
  exigence_corrosion            text NULL,
  pretraitement                 text NULL,
  posttraitement                text NULL,

  controles                     text[] NOT NULL DEFAULT ARRAY[]::text[],
  certificat_requis             boolean NOT NULL DEFAULT false,
  certificat_type               text NULL,
  conditionnement               text NULL,
  unite_achat                   text NOT NULL DEFAULT 'PCE',
  specification_client          text NULL,
  specification_client_version  text NULL,
  instructions                  text NULL,

  spec_canonical                jsonb NOT NULL,
  spec_fingerprint              text NOT NULL,

  article_id                    uuid NULL,
  achat_ligne_id                uuid NULL,

  generated_designation         text NOT NULL,
  generated_comment             text NOT NULL,
  template_version              integer NOT NULL DEFAULT 1,
  designation_override          text NULL,
  comment_override              text NULL,
  override_reason               text NULL,

  created_at                    timestamptz NOT NULL DEFAULT now(),
  updated_at                    timestamptz NOT NULL DEFAULT now(),
  created_by                    integer NULL,
  updated_by                    integer NULL,

  CONSTRAINT gamme_operation_finitions_gamme_fk FOREIGN KEY (gamme_id)
    REFERENCES public.gammes(id) ON DELETE CASCADE,
  CONSTRAINT gamme_operation_finitions_operation_fk FOREIGN KEY (gamme_operation_id)
    REFERENCES public.pieces_techniques_operations(id) ON DELETE CASCADE,
  CONSTRAINT gamme_operation_finitions_version_fk FOREIGN KEY (piece_technique_version_id)
    REFERENCES public.piece_technique_versions(id) ON DELETE CASCADE,
  -- RESTRICT : une révision utilisée par une gamme ne disparaît jamais en silence.
  CONSTRAINT gamme_operation_finitions_revision_fk FOREIGN KEY (finish_revision_id)
    REFERENCES public.surface_finish_revisions(id) ON DELETE RESTRICT,
  CONSTRAINT gamme_operation_finitions_article_fk FOREIGN KEY (article_id)
    REFERENCES public.articles(id) ON DELETE RESTRICT,
  CONSTRAINT gamme_operation_finitions_achat_fk FOREIGN KEY (achat_ligne_id)
    REFERENCES public.pieces_techniques_achats(id) ON DELETE SET NULL,

  -- Une opération porte AU PLUS une exigence de finition.
  CONSTRAINT gamme_operation_finitions_operation_uq UNIQUE (gamme_operation_id),

  CONSTRAINT gamme_operation_finitions_perimetre_check CHECK (
    perimetre IN ('PIECE_ENTIERE','ZONES','AUTRE')
  ),
  CONSTRAINT gamme_operation_finitions_zones_coherentes CHECK (
    perimetre <> 'ZONES' OR array_length(zones, 1) >= 1
  ),
  CONSTRAINT gamme_operation_finitions_unite_check CHECK (
    epaisseur_unite IN ('um','mm','cm','in','mil')
  ),
  CONSTRAINT gamme_operation_finitions_epaisseur_coherente CHECK (
    (epaisseur_min IS NULL OR epaisseur_max IS NULL OR epaisseur_min <= epaisseur_max)
    AND (epaisseur_nominale IS NULL OR epaisseur_min IS NULL OR epaisseur_nominale >= epaisseur_min)
    AND (epaisseur_nominale IS NULL OR epaisseur_max IS NULL OR epaisseur_nominale <= epaisseur_max)
  ),
  CONSTRAINT gamme_operation_finitions_fingerprint_format CHECK (
    spec_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT gamme_operation_finitions_override_reason CHECK (
    (designation_override IS NULL AND comment_override IS NULL)
    OR btrim(COALESCE(override_reason, '')) <> ''
  )
);

COMMENT ON TABLE public.gamme_operation_finitions IS
  '#210 — Exigence de finition d''une opération SOUS_TRAITANCE : liaison EXPLICITE gamme/opération/indice/révision + article résolu + ligne d''achat.';
COMMENT ON COLUMN public.gamme_operation_finitions.spec_fingerprint IS
  'SHA-256 de la spécification canonique. Fournisseur, prix, délai et MOQ en sont volontairement absents.';

CREATE INDEX IF NOT EXISTS gamme_operation_finitions_gamme_idx
  ON public.gamme_operation_finitions (gamme_id);
CREATE INDEX IF NOT EXISTS gamme_operation_finitions_version_idx
  ON public.gamme_operation_finitions (piece_technique_version_id);
CREATE INDEX IF NOT EXISTS gamme_operation_finitions_revision_idx
  ON public.gamme_operation_finitions (finish_revision_id);
CREATE INDEX IF NOT EXISTS gamme_operation_finitions_article_idx
  ON public.gamme_operation_finitions (article_id);
CREATE INDEX IF NOT EXISTS gamme_operation_finitions_fingerprint_idx
  ON public.gamme_operation_finitions (spec_fingerprint);

/* -------------------------------------------------------------------------- */
/* 7) Article de sous-traitance — EXTENSION de la spécialisation existante    */
/* -------------------------------------------------------------------------- */
-- On étend `articles_traitement` (PK article_id). Aucune table maître
-- concurrente d'`articles` n'est créée.

ALTER TABLE public.articles_traitement
  ADD COLUMN IF NOT EXISTS piece_technique_id          uuid NULL,
  ADD COLUMN IF NOT EXISTS piece_technique_version_id  uuid NULL,
  ADD COLUMN IF NOT EXISTS finish_revision_id          uuid NULL,
  ADD COLUMN IF NOT EXISTS spec_fingerprint            text NULL,
  ADD COLUMN IF NOT EXISTS spec_canonical              jsonb NULL,
  ADD COLUMN IF NOT EXISTS generated_designation       text NULL,
  ADD COLUMN IF NOT EXISTS generated_comment           text NULL,
  ADD COLUMN IF NOT EXISTS template_version            integer NULL,
  ADD COLUMN IF NOT EXISTS origin                      text NULL,
  ADD COLUMN IF NOT EXISTS superseded_at               timestamptz NULL,
  ADD COLUMN IF NOT EXISTS created_by                  integer NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'articles_traitement_piece_fk'
      AND conrelid = 'public.articles_traitement'::regclass
  ) THEN
    ALTER TABLE public.articles_traitement
      ADD CONSTRAINT articles_traitement_piece_fk
      FOREIGN KEY (piece_technique_id) REFERENCES public.pieces_techniques(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'articles_traitement_version_fk'
      AND conrelid = 'public.articles_traitement'::regclass
  ) THEN
    ALTER TABLE public.articles_traitement
      ADD CONSTRAINT articles_traitement_version_fk
      FOREIGN KEY (piece_technique_version_id) REFERENCES public.piece_technique_versions(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'articles_traitement_finish_revision_fk'
      AND conrelid = 'public.articles_traitement'::regclass
  ) THEN
    ALTER TABLE public.articles_traitement
      ADD CONSTRAINT articles_traitement_finish_revision_fk
      FOREIGN KEY (finish_revision_id) REFERENCES public.surface_finish_revisions(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'articles_traitement_origin_check'
      AND conrelid = 'public.articles_traitement'::regclass
  ) THEN
    ALTER TABLE public.articles_traitement
      ADD CONSTRAINT articles_traitement_origin_check
      CHECK (origin IS NULL OR origin IN ('GAMME_FINITION','MANUEL','IMPORT'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'articles_traitement_fingerprint_format'
      AND conrelid = 'public.articles_traitement'::regclass
  ) THEN
    ALTER TABLE public.articles_traitement
      ADD CONSTRAINT articles_traitement_fingerprint_format
      CHECK (spec_fingerprint IS NULL OR spec_fingerprint ~ '^[0-9a-f]{64}$');
  END IF;

  -- Une empreinte sans spécification (ou l'inverse) serait une identité orpheline.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'articles_traitement_spec_pair_check'
      AND conrelid = 'public.articles_traitement'::regclass
  ) THEN
    ALTER TABLE public.articles_traitement
      ADD CONSTRAINT articles_traitement_spec_pair_check
      CHECK ((spec_fingerprint IS NULL) = (spec_canonical IS NULL));
  END IF;
END $$;

-- ANTI-DOUBLON STRUCTUREL : une seule version COURANTE d'article par empreinte.
-- Deux confirmations concurrentes ne peuvent pas créer deux articles.
CREATE UNIQUE INDEX IF NOT EXISTS articles_traitement_fingerprint_current_uq
  ON public.articles_traitement (spec_fingerprint)
  WHERE spec_fingerprint IS NOT NULL AND superseded_at IS NULL;

CREATE INDEX IF NOT EXISTS articles_traitement_version_idx
  ON public.articles_traitement (piece_technique_version_id)
  WHERE piece_technique_version_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS articles_traitement_revision_idx
  ON public.articles_traitement (finish_revision_id)
  WHERE finish_revision_id IS NOT NULL;

COMMENT ON COLUMN public.articles_traitement.spec_fingerprint IS
  '#210 — Empreinte fonctionnelle de la prestation. Unique parmi les articles non remplacés.';
COMMENT ON COLUMN public.articles_traitement.superseded_at IS
  '#210 — Date à laquelle cette spécialisation a cédé sa place à une version plus récente. Aucune suppression.';

/* -------------------------------------------------------------------------- */
/* 8) Nomenclature d'achat — liaison par CLÉ ÉTRANGÈRE, plus par phase        */
/* -------------------------------------------------------------------------- */

ALTER TABLE public.pieces_techniques_achats
  ADD COLUMN IF NOT EXISTS gamme_operation_id          uuid NULL,
  ADD COLUMN IF NOT EXISTS gamme_id                    uuid NULL,
  ADD COLUMN IF NOT EXISTS piece_technique_version_id  uuid NULL,
  ADD COLUMN IF NOT EXISTS designation_snapshot        text NULL,
  ADD COLUMN IF NOT EXISTS source                      text NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'pt_achats_gamme_operation_fk'
      AND conrelid = 'public.pieces_techniques_achats'::regclass
  ) THEN
    ALTER TABLE public.pieces_techniques_achats
      ADD CONSTRAINT pt_achats_gamme_operation_fk
      FOREIGN KEY (gamme_operation_id) REFERENCES public.pieces_techniques_operations(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'pt_achats_gamme_fk'
      AND conrelid = 'public.pieces_techniques_achats'::regclass
  ) THEN
    ALTER TABLE public.pieces_techniques_achats
      ADD CONSTRAINT pt_achats_gamme_fk
      FOREIGN KEY (gamme_id) REFERENCES public.gammes(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'pt_achats_version_fk'
      AND conrelid = 'public.pieces_techniques_achats'::regclass
  ) THEN
    ALTER TABLE public.pieces_techniques_achats
      ADD CONSTRAINT pt_achats_version_fk
      FOREIGN KEY (piece_technique_version_id) REFERENCES public.piece_technique_versions(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'pt_achats_source_check'
      AND conrelid = 'public.pieces_techniques_achats'::regclass
  ) THEN
    ALTER TABLE public.pieces_techniques_achats
      ADD CONSTRAINT pt_achats_source_check
      CHECK (source IS NULL OR source IN ('GAMME_FINITION','MANUEL','IMPORT'));
  END IF;
END $$;

-- Une opération de gamme porte au plus UNE ligne d'achat de traitement.
CREATE UNIQUE INDEX IF NOT EXISTS pt_achats_gamme_operation_traitement_uq
  ON public.pieces_techniques_achats (gamme_operation_id)
  WHERE gamme_operation_id IS NOT NULL AND type_achat = 'TRAITEMENT';

CREATE INDEX IF NOT EXISTS pt_achats_gamme_idx
  ON public.pieces_techniques_achats (gamme_id)
  WHERE gamme_id IS NOT NULL;

COMMENT ON COLUMN public.pieces_techniques_achats.gamme_operation_id IS
  '#210 — Lien AUTORITAIRE vers l''opération source. Le champ `phase` reste informatif et ne porte plus aucun lien.';

/* -------------------------------------------------------------------------- */
/* 9) Reçus d'idempotence des commandes de finition                           */
/* -------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS public.surface_finish_command_receipts (
  idempotency_key text PRIMARY KEY,
  command_type    text NOT NULL,
  request_hash    text NOT NULL,
  result          jsonb NOT NULL,
  user_id         integer NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT surface_finish_command_receipts_hash_format CHECK (request_hash ~ '^[0-9a-f]{64}$')
);

COMMENT ON TABLE public.surface_finish_command_receipts IS
  '#210 — Reçus d''idempotence : même clé + même charge ⇒ même réponse ; même clé + charge différente ⇒ 409.';

CREATE INDEX IF NOT EXISTS surface_finish_command_receipts_created_idx
  ON public.surface_finish_command_receipts (created_at DESC);

/* -------------------------------------------------------------------------- */
/* 10) Immuabilité du code finition + updated_at                              */
/* -------------------------------------------------------------------------- */

CREATE OR REPLACE FUNCTION public.fn_protect_surface_finish_code_210()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.code IS DISTINCT FROM OLD.code THEN
    RAISE EXCEPTION 'Le code d''une finition est immuable (% -> %)', OLD.code, NEW.code
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_surface_finish_code_immutable ON public.surface_finishes;
CREATE TRIGGER trg_surface_finish_code_immutable
  BEFORE UPDATE ON public.surface_finishes
  FOR EACH ROW EXECUTE FUNCTION public.fn_protect_surface_finish_code_210();

DO $$
BEGIN
  IF to_regprocedure('public.tg_set_updated_at()') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS surface_finishes_set_updated_at ON public.surface_finishes';
    EXECUTE 'CREATE TRIGGER surface_finishes_set_updated_at BEFORE UPDATE ON public.surface_finishes FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at()';

    EXECUTE 'DROP TRIGGER IF EXISTS surface_finish_revisions_set_updated_at ON public.surface_finish_revisions';
    EXECUTE 'CREATE TRIGGER surface_finish_revisions_set_updated_at BEFORE UPDATE ON public.surface_finish_revisions FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at()';

    EXECUTE 'DROP TRIGGER IF EXISTS gamme_operation_finitions_set_updated_at ON public.gamme_operation_finitions';
    EXECUTE 'CREATE TRIGGER gamme_operation_finitions_set_updated_at BEFORE UPDATE ON public.gamme_operation_finitions FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at()';

    EXECUTE 'DROP TRIGGER IF EXISTS surface_finish_families_set_updated_at ON public.surface_finish_families';
    EXECUTE 'CREATE TRIGGER surface_finish_families_set_updated_at BEFORE UPDATE ON public.surface_finish_families FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at()';
  END IF;
END $$;

/* -------------------------------------------------------------------------- */
/* 11) Droits du rôle applicatif                                              */
/* -------------------------------------------------------------------------- */
-- Les reçus d'idempotence sont append-only côté application : ni UPDATE ni DELETE.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON public.surface_finish_families TO cerp_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON public.surface_finishes TO cerp_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON public.surface_finish_revisions TO cerp_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON public.surface_finish_revision_documents TO cerp_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON public.gamme_operation_finitions TO cerp_app';
    EXECUTE 'GRANT SELECT, INSERT ON public.surface_finish_command_receipts TO cerp_app';
    EXECUTE 'REVOKE UPDATE, DELETE ON public.surface_finish_command_receipts FROM cerp_app';
  END IF;
END $$;

COMMIT;
