-- 20260729_methodes_gamme_referentials.sql
--
-- Méthodes : familles machine, centres de frais tarifés, parc machine et éditeur de gamme.
-- ADR : crp-systems-web/docs/adr/ADR-0046-methodes-referentiels-gamme.md
-- Audit préalable : crp-systems-web/docs/architecture/methodes-gamme-audit-2026-07-29.md
--
-- ADDITIF, IDEMPOTENT, NON DESTRUCTIF :
--   - 2 nouvelles tables (`production_machine_families`, `production_cost_center_rates`) ;
--   - colonnes NULLABLES (ou avec DEFAULT) ajoutées à `centres_frais`, `machines`,
--     `pieces_techniques_operations` et `of_operations` ;
--   - élargissement du CHECK `type_operation` au type `DECOUPE` ;
--   - seed du référentiel de familles en ON CONFLICT DO NOTHING.
--   Aucune table n'est renommée, vidée ni recodée. Aucune colonne n'est supprimée.
--
-- LA SEULE ÉCRITURE SUR DES LIGNES EXISTANTES est la recopie de conservation
-- `taux_horaire` -> `taux_horaire_legacy` (section 6). Elle n'écrit QUE dans une
-- colonne créée par ce patch, elle est bornée par `IS NULL`, et elle existe
-- précisément pour « préserver les anciennes valeurs avant dépréciation ».
--
-- AUCUN BACKFILL DE FAMILLE MACHINE. `machines.type` (MILLING/TURNING/…) ne
-- distingue pas une machine CN d'une machine conventionnelle : en déduire `T` ou
-- `F` fabriquerait une donnée fausse. ADR-0020 l'interdit déjà (« ne pas déduire
-- depuis le code machine »). Un rapport de candidats à valider par les Méthodes
-- est fourni : db/patches/support/20260729_methodes_gamme_referentials.candidates.sql
--
-- UNITÉ DES TEMPS : la base reste en HEURES DÉCIMALES. Preuve relevée le
-- 2026-07-29 sur `cerp_test` : une opération tp=2.000, taux_horaire=50.00 porte
-- cout_mo=105.00 pour temps_total=2.100 — `cout_mo = temps_total × taux_horaire`
-- n'est homogène que si `temps_total` est en heures. Aucune conversion de
-- données n'est donc effectuée ; la saisie en minutes est convertie côté
-- application (`methodes-policy.ts`, `gamme-time.ts`).
--
-- Pipeline db/patches (exécuté en tant que `cerp_app`). Cible : PostgreSQL 17.
--   Preflight  : db/patches/support/20260729_methodes_gamme_referentials.preflight.sql
--   Verify     : db/patches/support/20260729_methodes_gamme_referentials.verify.sql
--   Rollback   : db/patches/support/20260729_methodes_gamme_referentials.rollback.sql
--   Candidats  : db/patches/support/20260729_methodes_gamme_referentials.candidates.sql
-- Si le patch est appliqué via `sudo -u postgres psql`, exécuter ensuite
-- db/privileged/20260721_fix_app_table_ownership.sql (les nouvelles tables
-- doivent appartenir à `cerp_app`, sinon 42501 puis 500 côté API).

BEGIN;

/* -------------------------------------------------------------------------- */
/* 0) Pré-requis structurels                                                  */
/* -------------------------------------------------------------------------- */

DO $$
BEGIN
  IF to_regclass('public.centres_frais') IS NULL THEN
    RAISE EXCEPTION 'methodes: public.centres_frais est absent';
  END IF;
  IF to_regclass('public.machines') IS NULL THEN
    RAISE EXCEPTION 'methodes: public.machines est absent — appliquer 2026-02-12_production_of_machines_postes.sql';
  END IF;
  IF to_regclass('public.pieces_techniques_operations') IS NULL THEN
    RAISE EXCEPTION 'methodes: public.pieces_techniques_operations est absent — appliquer 00001_production_pieces_techniques_gammes.sql';
  END IF;
  IF to_regclass('public.of_operations') IS NULL THEN
    RAISE EXCEPTION 'methodes: public.of_operations est absent — appliquer 2026-02-12_production_of_machines_postes.sql';
  END IF;
  IF to_regclass('public.gammes') IS NULL THEN
    RAISE EXCEPTION 'methodes: public.gammes est absent — appliquer 20260707_pieces_techniques_gpao_versions_gammes.sql';
  END IF;
END $$;

/* -------------------------------------------------------------------------- */
/* 1) Référentiel des familles machine — extensible                           */
/* -------------------------------------------------------------------------- */
-- Une FAMILLE MACHINE est un classement métier (T, F, TTRAD, FTRAD, DECOUPE…).
-- Elle n'est ni un CENTRE DE FRAIS (unité de coût), ni une MACHINE (instance
-- physique). Les trois objets restent distincts et le référentiel s'étend par
-- INSERT, jamais par modification d'un enum.

CREATE TABLE IF NOT EXISTS public.production_machine_families (
  code                text PRIMARY KEY,
  libelle             text NOT NULL,
  description         text,
  -- `true` = le n° de programme est obligatoire sur une opération de cette famille.
  programme_requis    boolean NOT NULL DEFAULT false,
  -- `true` = famille mise en avant dans les sélecteurs (favoris).
  est_favori          boolean NOT NULL DEFAULT false,
  ordre_affichage     integer NOT NULL DEFAULT 100,
  actif               boolean NOT NULL DEFAULT true,
  created_at          timestamp with time zone NOT NULL DEFAULT now(),
  updated_at          timestamp with time zone NOT NULL DEFAULT now(),
  created_by          integer,
  updated_by          integer
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'production_machine_families_code_ck'
      AND conrelid = 'public.production_machine_families'::regclass
  ) THEN
    ALTER TABLE public.production_machine_families
      ADD CONSTRAINT production_machine_families_code_ck
      CHECK (code = upper(btrim(code)) AND code ~ '^[A-Z0-9_]{1,24}$');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'production_machine_families_created_by_fkey'
      AND conrelid = 'public.production_machine_families'::regclass
  ) THEN
    ALTER TABLE public.production_machine_families
      ADD CONSTRAINT production_machine_families_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES public.users (id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'production_machine_families_updated_by_fkey'
      AND conrelid = 'public.production_machine_families'::regclass
  ) THEN
    ALTER TABLE public.production_machine_families
      ADD CONSTRAINT production_machine_families_updated_by_fkey
      FOREIGN KEY (updated_by) REFERENCES public.users (id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS production_machine_families_actif_idx
  ON public.production_machine_families (actif, ordre_affichage);

-- Familles initiales. `ON CONFLICT DO NOTHING` : un libellé déjà ajusté par les
-- Méthodes n'est jamais réécrit par une réapplication du patch.
INSERT INTO public.production_machine_families
  (code, libelle, description, programme_requis, est_favori, ordre_affichage, actif)
VALUES
  ('T',       'Tournage CN',            'Tours à commande numérique.',              true,  true,  10, true),
  ('F',       'Fraisage CN',            'Centres d''usinage à commande numérique.', true,  true,  20, true),
  ('TTRAD',   'Tour conventionnel',     'Tours traditionnels sans CN.',             false, false, 30, true),
  ('FTRAD',   'Fraisage conventionnel', 'Fraiseuses traditionnelles sans CN.',      false, false, 40, true),
  ('DECOUPE', 'Découpe',                'Débit et découpe matière.',                false, false, 50, true)
ON CONFLICT (code) DO NOTHING;

/* -------------------------------------------------------------------------- */
/* 2) Centres de frais — identité, famille, statut, désignation automatique    */
/* -------------------------------------------------------------------------- */
-- Un CENTRE DE FRAIS porte le TAUX HORAIRE (section 3). Le taux n'est plus une
-- saisie libre de l'opération.

ALTER TABLE public.centres_frais
  ADD COLUMN IF NOT EXISTS machine_family_code   text,
  ADD COLUMN IF NOT EXISTS statut                text NOT NULL DEFAULT 'ACTIF',
  ADD COLUMN IF NOT EXISTS devise                text NOT NULL DEFAULT 'EUR',
  -- Règle de désignation automatique : gabarit à variables en liste blanche,
  -- rendu par le serveur (`buildCostCenterDesignation`). NULL = pas de règle.
  ADD COLUMN IF NOT EXISTS designation_modele    text,
  ADD COLUMN IF NOT EXISTS designation_auto      boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS commentaire           text,
  ADD COLUMN IF NOT EXISTS archived_at           timestamp with time zone,
  ADD COLUMN IF NOT EXISTS created_by            integer,
  ADD COLUMN IF NOT EXISTS updated_by            integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'centres_frais_statut_ck' AND conrelid = 'public.centres_frais'::regclass
  ) THEN
    ALTER TABLE public.centres_frais
      ADD CONSTRAINT centres_frais_statut_ck
      CHECK (statut IN ('ACTIF', 'SUSPENDU', 'ARCHIVE'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'centres_frais_family_fkey' AND conrelid = 'public.centres_frais'::regclass
  ) THEN
    ALTER TABLE public.centres_frais
      ADD CONSTRAINT centres_frais_family_fkey
      FOREIGN KEY (machine_family_code) REFERENCES public.production_machine_families (code)
      ON UPDATE CASCADE ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'centres_frais_created_by_fkey' AND conrelid = 'public.centres_frais'::regclass
  ) THEN
    ALTER TABLE public.centres_frais
      ADD CONSTRAINT centres_frais_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES public.users (id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'centres_frais_updated_by_fkey' AND conrelid = 'public.centres_frais'::regclass
  ) THEN
    ALTER TABLE public.centres_frais
      ADD CONSTRAINT centres_frais_updated_by_fkey
      FOREIGN KEY (updated_by) REFERENCES public.users (id) ON DELETE SET NULL;
  END IF;
END $$;

-- Unicité du code, insensible à la casse. Créée SEULEMENT si les données
-- existantes le permettent : un patch ne casse pas une base sous prétexte
-- d'hygiène. Si des doublons existent, l'index est ignoré et le verify le dit.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class WHERE relname = 'centres_frais_code_uidx' AND relkind = 'i'
  ) AND NOT EXISTS (
    SELECT 1 FROM public.centres_frais GROUP BY upper(btrim(code)) HAVING count(*) > 1
  ) THEN
    CREATE UNIQUE INDEX centres_frais_code_uidx ON public.centres_frais (upper(btrim(code)));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS centres_frais_family_idx
  ON public.centres_frais (machine_family_code) WHERE machine_family_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS centres_frais_statut_idx ON public.centres_frais (statut);

/* -------------------------------------------------------------------------- */
/* 3) Taux horaire du centre de frais — VERSIONNÉ, jamais écrasé              */
/* -------------------------------------------------------------------------- */
-- Chaque tarif est une ligne datée. On ne modifie pas une ligne en vigueur :
-- on la clôt (`date_fin`, `superseded_by`) et on en insère une nouvelle.
-- `source` est obligatoire (ADR-0020 §6 : un taux sans provenance n'existe pas ;
-- `0` n'est jamais créé pour remplacer une valeur inconnue).

CREATE TABLE IF NOT EXISTS public.production_cost_center_rates (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cf_id          uuid NOT NULL,
  taux_horaire   numeric(12, 4) NOT NULL,
  devise         text NOT NULL DEFAULT 'EUR',
  date_effet     date NOT NULL,
  date_fin       date,
  source         text NOT NULL,
  commentaire    text,
  superseded_at  timestamp with time zone,
  superseded_by  uuid,
  created_at     timestamp with time zone NOT NULL DEFAULT now(),
  created_by     integer
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'cost_center_rates_cf_fkey' AND conrelid = 'public.production_cost_center_rates'::regclass
  ) THEN
    ALTER TABLE public.production_cost_center_rates
      ADD CONSTRAINT cost_center_rates_cf_fkey
      FOREIGN KEY (cf_id) REFERENCES public.centres_frais (id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'cost_center_rates_superseded_fkey' AND conrelid = 'public.production_cost_center_rates'::regclass
  ) THEN
    ALTER TABLE public.production_cost_center_rates
      ADD CONSTRAINT cost_center_rates_superseded_fkey
      FOREIGN KEY (superseded_by) REFERENCES public.production_cost_center_rates (id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'cost_center_rates_created_by_fkey' AND conrelid = 'public.production_cost_center_rates'::regclass
  ) THEN
    ALTER TABLE public.production_cost_center_rates
      ADD CONSTRAINT cost_center_rates_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES public.users (id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'cost_center_rates_amount_ck' AND conrelid = 'public.production_cost_center_rates'::regclass
  ) THEN
    ALTER TABLE public.production_cost_center_rates
      ADD CONSTRAINT cost_center_rates_amount_ck CHECK (taux_horaire >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'cost_center_rates_period_ck' AND conrelid = 'public.production_cost_center_rates'::regclass
  ) THEN
    ALTER TABLE public.production_cost_center_rates
      ADD CONSTRAINT cost_center_rates_period_ck CHECK (date_fin IS NULL OR date_fin >= date_effet);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'cost_center_rates_source_ck' AND conrelid = 'public.production_cost_center_rates'::regclass
  ) THEN
    ALTER TABLE public.production_cost_center_rates
      ADD CONSTRAINT cost_center_rates_source_ck CHECK (btrim(source) <> '');
  END IF;
END $$;

-- Un seul tarif par centre et par date d'effet : deux vérités le même jour
-- rendraient le gel de snapshot non déterministe.
CREATE UNIQUE INDEX IF NOT EXISTS cost_center_rates_cf_date_uidx
  ON public.production_cost_center_rates (cf_id, date_effet);
CREATE INDEX IF NOT EXISTS cost_center_rates_cf_recent_idx
  ON public.production_cost_center_rates (cf_id, date_effet DESC);
-- Au plus un tarif ouvert (sans date de fin) par centre de frais.
CREATE UNIQUE INDEX IF NOT EXISTS cost_center_rates_cf_open_uidx
  ON public.production_cost_center_rates (cf_id) WHERE date_fin IS NULL;

/* -------------------------------------------------------------------------- */
/* 4) Machines — famille, centre de frais, validité                           */
/* -------------------------------------------------------------------------- */
-- `machines` reste la source de vérité des instances physiques (ADR-0020).
-- `status` (structurel) et `is_available` (disponibilité) existent déjà et ne
-- sont pas dupliqués ; on ajoute la VALIDITÉ calendaire de l'instance.

ALTER TABLE public.machines
  ADD COLUMN IF NOT EXISTS machine_family_code text,
  ADD COLUMN IF NOT EXISTS cf_id               uuid,
  ADD COLUMN IF NOT EXISTS valid_from          date,
  ADD COLUMN IF NOT EXISTS valid_to            date;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'machines_family_fkey' AND conrelid = 'public.machines'::regclass
  ) THEN
    ALTER TABLE public.machines
      ADD CONSTRAINT machines_family_fkey
      FOREIGN KEY (machine_family_code) REFERENCES public.production_machine_families (code)
      ON UPDATE CASCADE ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'machines_cf_fkey' AND conrelid = 'public.machines'::regclass
  ) THEN
    ALTER TABLE public.machines
      ADD CONSTRAINT machines_cf_fkey
      FOREIGN KEY (cf_id) REFERENCES public.centres_frais (id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'machines_validity_ck' AND conrelid = 'public.machines'::regclass
  ) THEN
    ALTER TABLE public.machines
      ADD CONSTRAINT machines_validity_ck
      CHECK (valid_from IS NULL OR valid_to IS NULL OR valid_to >= valid_from);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS machines_family_idx
  ON public.machines (machine_family_code) WHERE machine_family_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS machines_cf_idx
  ON public.machines (cf_id) WHERE cf_id IS NOT NULL;

/* -------------------------------------------------------------------------- */
/* 5) Opérations de gamme — programme, famille, temps décomposés, gel du taux  */
/* -------------------------------------------------------------------------- */

ALTER TABLE public.pieces_techniques_operations
  ADD COLUMN IF NOT EXISTS numero_programme         text,
  ADD COLUMN IF NOT EXISTS machine_family_code      text,
  -- temps_fabrication = tf_unit × qte × coef ; temps_total (existant) = tp + temps_fabrication.
  ADD COLUMN IF NOT EXISTS temps_fabrication        numeric(12, 4) NOT NULL DEFAULT 0,
  -- Gel du tarif : quel tarif de centre de frais a produit `taux_horaire`.
  ADD COLUMN IF NOT EXISTS cf_rate_id               uuid,
  ADD COLUMN IF NOT EXISTS taux_horaire_source      text,
  ADD COLUMN IF NOT EXISTS taux_horaire_effective_at date,
  -- Conservation de la valeur saisie librement avant dépréciation (section 6).
  ADD COLUMN IF NOT EXISTS taux_horaire_legacy      numeric,
  ADD COLUMN IF NOT EXISTS designation_auto         boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS created_by               integer,
  ADD COLUMN IF NOT EXISTS updated_by               integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'pt_operations_family_fkey' AND conrelid = 'public.pieces_techniques_operations'::regclass
  ) THEN
    ALTER TABLE public.pieces_techniques_operations
      ADD CONSTRAINT pt_operations_family_fkey
      FOREIGN KEY (machine_family_code) REFERENCES public.production_machine_families (code)
      ON UPDATE CASCADE ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'pt_operations_cf_rate_fkey' AND conrelid = 'public.pieces_techniques_operations'::regclass
  ) THEN
    ALTER TABLE public.pieces_techniques_operations
      ADD CONSTRAINT pt_operations_cf_rate_fkey
      FOREIGN KEY (cf_rate_id) REFERENCES public.production_cost_center_rates (id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'pt_operations_temps_fabrication_ck' AND conrelid = 'public.pieces_techniques_operations'::regclass
  ) THEN
    ALTER TABLE public.pieces_techniques_operations
      ADD CONSTRAINT pt_operations_temps_fabrication_ck CHECK (temps_fabrication >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'pt_operations_taux_source_ck' AND conrelid = 'public.pieces_techniques_operations'::regclass
  ) THEN
    ALTER TABLE public.pieces_techniques_operations
      ADD CONSTRAINT pt_operations_taux_source_ck
      CHECK (taux_horaire_source IS NULL
             OR taux_horaire_source IN ('CENTRE_FRAIS', 'HISTORIQUE_LEGACY', 'ABSENT'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'pt_operations_programme_ck' AND conrelid = 'public.pieces_techniques_operations'::regclass
  ) THEN
    ALTER TABLE public.pieces_techniques_operations
      ADD CONSTRAINT pt_operations_programme_ck
      CHECK (numero_programme IS NULL OR btrim(numero_programme) <> '');
  END IF;
END $$;

-- `DECOUPE` rejoint les types d'opération. Aucun type existant n'est retiré.
DO $$
BEGIN
  ALTER TABLE public.pieces_techniques_operations
    DROP CONSTRAINT IF EXISTS pieces_techniques_operations_type_operation_check;
  ALTER TABLE public.pieces_techniques_operations
    ADD CONSTRAINT pieces_techniques_operations_type_operation_check
    CHECK (type_operation IS NULL OR type_operation IN
      ('TOURNAGE', 'FRAISAGE', 'DECOUPE', 'REPRISE', 'CONTROLE',
       'LAVAGE', 'SOUS_TRAITANCE', 'EMBALLAGE', 'AUTRE'));
END $$;

-- Anti-collision des phases DANS une gamme. Créé seulement si les données le
-- permettent : les opérations historiques sans `gamme_id` ne sont pas concernées.
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
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS pt_operations_gamme_ordre_idx
  ON public.pieces_techniques_operations (gamme_id, ordre) WHERE gamme_id IS NOT NULL;

/* -------------------------------------------------------------------------- */
/* 6) Conservation des taux saisis librement avant dépréciation               */
/* -------------------------------------------------------------------------- */
-- Le taux horaire ne se saisit plus sur l'opération. Avant que le champ ne
-- devienne le reflet d'un tarif de centre de frais, la valeur saisie
-- historiquement est recopiée dans `taux_horaire_legacy` (colonne créée par ce
-- patch, donc jamais renseignée auparavant). `taux_horaire` n'est PAS modifié :
-- les coûts déjà calculés restent lisibles à l'identique.

UPDATE public.pieces_techniques_operations
SET taux_horaire_legacy = taux_horaire
WHERE taux_horaire_legacy IS NULL
  AND taux_horaire IS NOT NULL
  AND taux_horaire <> 0;

-- Les opérations existantes portent un taux dont on ne connaît pas la source :
-- on le dit explicitement plutôt que de laisser croire qu'il vient d'un centre
-- de frais. `NULL` reste possible pour une opération sans taux.
UPDATE public.pieces_techniques_operations
SET taux_horaire_source = 'HISTORIQUE_LEGACY'
WHERE taux_horaire_source IS NULL
  AND taux_horaire IS NOT NULL
  AND taux_horaire <> 0;

/* -------------------------------------------------------------------------- */
/* 7) Snapshot OF — l'historique lancé ne bouge plus                          */
/* -------------------------------------------------------------------------- */
-- Volontairement SANS clé étrangère vers les référentiels : un snapshot d'OF est
-- une preuve figée. Une famille renommée, un tarif clos ou un centre de frais
-- archivé ne doivent ni casser l'insertion, ni effacer la trace (`ON DELETE SET
-- NULL` détruirait justement la preuve).

ALTER TABLE public.of_operations
  ADD COLUMN IF NOT EXISTS numero_programme          text,
  ADD COLUMN IF NOT EXISTS machine_family_code       text,
  ADD COLUMN IF NOT EXISTS cf_code_snapshot          text,
  ADD COLUMN IF NOT EXISTS cf_rate_id                uuid,
  ADD COLUMN IF NOT EXISTS temps_fabrication_planned numeric(12, 4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS hourly_rate_source        text,
  ADD COLUMN IF NOT EXISTS hourly_rate_effective_at  date;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'of_operations_temps_fabrication_ck' AND conrelid = 'public.of_operations'::regclass
  ) THEN
    ALTER TABLE public.of_operations
      ADD CONSTRAINT of_operations_temps_fabrication_ck CHECK (temps_fabrication_planned >= 0);
  END IF;
END $$;

/* -------------------------------------------------------------------------- */
/* 8) Catalogue d'accès (#326) — le préfixe /methodes rejoint Données techniques */
/* -------------------------------------------------------------------------- */
-- Les référentiels Méthodes ne créent pas un module d'accès distinct : ils
-- appartiennent à « Données techniques », comme les gammes et les finitions.
-- Mise à jour ciblée et idempotente d'une ligne de CATALOGUE (pas de donnée
-- métier), pour que la base reste le miroir de `module-catalog.ts`.

DO $$
BEGIN
  IF to_regclass('public.access_modules') IS NOT NULL THEN
    UPDATE public.access_modules
    SET api_prefixes = array_append(api_prefixes, '/methodes'),
        updated_at   = now()
    WHERE module_key = 'pieces-techniques'
      AND NOT ('/methodes' = ANY (api_prefixes));

    -- Sans cette page key, l'entrée « Centres de frais » disparaîtrait de la
    -- navigation de tout compte dont le profil d'accès est filtré.
    UPDATE public.access_modules
    SET nav_page_keys = array_append(nav_page_keys, 'methodes-centres-frais'),
        updated_at    = now()
    WHERE module_key = 'pieces-techniques'
      AND NOT ('methodes-centres-frais' = ANY (nav_page_keys));
  END IF;
END $$;

/* -------------------------------------------------------------------------- */
/* 9) Documentation embarquée                                                 */
/* -------------------------------------------------------------------------- */

COMMENT ON TABLE public.production_machine_families IS
  'Référentiel extensible des familles machine (T, F, TTRAD, FTRAD, DECOUPE…). Distinct du centre de frais et de la machine physique.';
COMMENT ON TABLE public.production_cost_center_rates IS
  'Historique versionné des taux horaires par centre de frais. Une ligne n''est jamais écrasée : elle est close puis remplacée.';
COMMENT ON COLUMN public.pieces_techniques_operations.tp IS
  'Temps de préparation en HEURES DÉCIMALES (la saisie en minutes est convertie par l''application).';
COMMENT ON COLUMN public.pieces_techniques_operations.tf_unit IS
  'Temps unitaire en HEURES DÉCIMALES (la saisie en minutes est convertie par l''application).';
COMMENT ON COLUMN public.pieces_techniques_operations.temps_fabrication IS
  'temps_fabrication = tf_unit × qte × coef, en heures décimales.';
COMMENT ON COLUMN public.pieces_techniques_operations.temps_total IS
  'temps_final = tp + temps_fabrication, en heures décimales. Jamais saisi manuellement.';
COMMENT ON COLUMN public.pieces_techniques_operations.taux_horaire IS
  'Taux appliqué, FIGÉ depuis le tarif du centre de frais (cf_rate_id). N''est plus une saisie libre.';
COMMENT ON COLUMN public.pieces_techniques_operations.taux_horaire_legacy IS
  'Valeur saisie librement avant la dépréciation de la saisie sur opération. Conservation, lecture seule.';

COMMIT;
