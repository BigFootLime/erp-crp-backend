-- 20260726_metrologie_360_229.sql
-- Issue #229 — Métrologie 360 : référentiel équipements, plans versionnés,
-- étalonnages / vérifications, certificats privés, hors tolérance, quarantaine
-- et analyse d'impact bornée.
--
-- Propriétés du patch :
--   * ADDITIF uniquement : aucune table, colonne, contrainte ou donnée
--     historique supprimée. `metrologie_equipements`, `metrologie_plan`,
--     `metrologie_certificats` et `metrologie_event_log` sont ÉTENDUS, jamais
--     remplacés par une seconde nomenclature.
--   * IDEMPOTENT : rejouable sans effet de bord.
--   * TRANSACTIONNEL : BEGIN/COMMIT, rien de partiel.
--   * INACTIF sur le métier : ne crée aucun équipement, aucun plan, aucune
--     exécution, aucune quarantaine et aucun dossier d'impact. Il ne renumérote
--     rien et ne modifie aucun statut existant. Seules les CATÉGORIES (données
--     de référentiel, désactivables) sont semées.
--   * Réversible : `db/patches/support/20260726_metrologie_360_229.rollback.sql`
--     (restreint à cerp_test, refuse de s'exécuter sur des données réelles).
--
-- Jamais exécuté en production par ce patch : l'application se fait sur
-- cerp_test, puis cerp_prod uniquement sur autorisation humaine explicite.

BEGIN;

/* -------------------------------------------------------------------------- */
/* 0) Pré-requis                                                              */
/* -------------------------------------------------------------------------- */

DO $$
BEGIN
  IF to_regclass('public.metrologie_equipements') IS NULL THEN
    RAISE EXCEPTION '#229 requires the Métrologie baseline (20260227_metrologie_calibration.sql)';
  END IF;
  IF to_regclass('public.metrologie_plan') IS NULL THEN
    RAISE EXCEPTION '#229 requires public.metrologie_plan';
  END IF;
  IF to_regclass('public.metrologie_certificats') IS NULL THEN
    RAISE EXCEPTION '#229 requires public.metrologie_certificats';
  END IF;
  IF to_regclass('public.quality_control') IS NULL THEN
    RAISE EXCEPTION '#229 requires the Qualité baseline (20260213_qualite_module.sql)';
  END IF;
  IF to_regclass('public.users') IS NULL THEN
    RAISE EXCEPTION '#229 requires public.users';
  END IF;
  IF to_regprocedure('public.fn_next_issued_code_value(text)') IS NULL THEN
    RAISE EXCEPTION '#229: public.fn_next_issued_code_value(text) is missing — apply 20260713_codification_versions_of_vsm.sql first';
  END IF;
END $$;

/* -------------------------------------------------------------------------- */
/* 1) Codification serveur                                                    */
/*                                                                            */
/*    Corps identique aux versions 20260713 / 20260721 / 20260722 / 20260725 : */
/*    SEUL le périmètre autorisé change. #229 :                                */
/*      - ajoute MET (équipement), MEX:AAAA (exécution), MIA:AAAA (impact) ;   */
/*      - RESTAURE MCH (parc machines #165), perdu lors de la réécriture du    */
/*        garde par 20260725_qualite_360_228.sql — sans quoi la création d'une */
/*        machine échoue en 22023 sur une base à jour.                         */
/* -------------------------------------------------------------------------- */

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

COMMENT ON FUNCTION public.fn_next_issued_code_value(text) IS
  'Whitelisted, non-reusable business-code allocator backed by a native PostgreSQL sequence. #229 adds MET/MEX/MIA (métrologie) and restores MCH (#165).';

/* -------------------------------------------------------------------------- */
/* 2) Référentiel des catégories d''équipement                                */
/*                                                                            */
/*    Référentiel administré et versionné : on DÉSACTIVE une catégorie         */
/*    utilisée, on ne la supprime pas. Il ne remplace pas les familles         */
/*    Articles/Stock : il ne décrit que des moyens de mesure.                  */
/* -------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS public.metrologie_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL,
  parent_code text NULL,
  label text NOT NULL,
  description text NULL,
  version integer NOT NULL DEFAULT 1,
  active boolean NOT NULL DEFAULT true,
  display_order integer NOT NULL DEFAULT 100,

  -- Exigences de saisie pilotées par le référentiel : elles conditionnent la
  -- validation serveur des spécifications de l'équipement.
  requires_range boolean NOT NULL DEFAULT false,
  requires_resolution boolean NOT NULL DEFAULT false,
  requires_uncertainty boolean NOT NULL DEFAULT false,
  requires_unit boolean NOT NULL DEFAULT false,
  default_unit text NULL,
  default_periodicity_months integer NULL,
  default_operation_type text NOT NULL DEFAULT 'ETALONNAGE',

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by integer NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE SET NULL,
  updated_by integer NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE SET NULL,

  CONSTRAINT metrologie_categories_code_229_uq UNIQUE (code),
  CONSTRAINT metrologie_categories_code_229_ck CHECK (code ~ '^[A-Z0-9_]{2,40}$'),
  CONSTRAINT metrologie_categories_parent_229_ck CHECK (parent_code IS NULL OR parent_code <> code),
  CONSTRAINT metrologie_categories_version_229_ck CHECK (version >= 1),
  CONSTRAINT metrologie_categories_periodicity_229_ck
    CHECK (default_periodicity_months IS NULL OR default_periodicity_months BETWEEN 1 AND 600),
  CONSTRAINT metrologie_categories_operation_229_ck
    CHECK (default_operation_type IN ('ETALONNAGE', 'VERIFICATION'))
);

CREATE INDEX IF NOT EXISTS metrologie_categories_active_229_idx
  ON public.metrologie_categories (active, display_order, code);

CREATE INDEX IF NOT EXISTS metrologie_categories_parent_229_idx
  ON public.metrologie_categories (parent_code);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'metrologie_categories_parent_229_fkey'
      AND conrelid = 'public.metrologie_categories'::regclass
  ) THEN
    ALTER TABLE public.metrologie_categories
      ADD CONSTRAINT metrologie_categories_parent_229_fkey
      FOREIGN KEY (parent_code) REFERENCES public.metrologie_categories(code)
      ON UPDATE RESTRICT ON DELETE RESTRICT;
  END IF;
END $$;

-- Semis du référentiel de base (données de référentiel, pas de données métier).
INSERT INTO public.metrologie_categories
  (code, label, display_order, requires_range, requires_resolution, requires_unit,
   requires_uncertainty, default_unit, default_periodicity_months, default_operation_type)
VALUES
  ('PIED_A_COULISSE', 'Pied à coulisse',        10, true,  true,  true,  false, 'mm',   12, 'ETALONNAGE'),
  ('MICROMETRE',      'Micromètre',             20, true,  true,  true,  false, 'mm',   12, 'ETALONNAGE'),
  ('COMPARATEUR',     'Comparateur',            30, true,  true,  true,  false, 'mm',   12, 'ETALONNAGE'),
  ('CALIBRE',         'Calibre / tampon',       40, false, false, true,  false, 'mm',   12, 'VERIFICATION'),
  ('MMT',             'Machine à mesurer (MMT)',50, true,  true,  true,  true,  'mm',   12, 'ETALONNAGE'),
  ('MACHINE_MESURE',  'Machine de mesure',      60, true,  true,  true,  true,  'mm',   12, 'ETALONNAGE'),
  ('BALANCE',         'Balance / pesage',       70, true,  true,  true,  true,  'g',    12, 'ETALONNAGE'),
  ('TEMPERATURE',     'Température',            80, true,  true,  true,  true,  '°C',   12, 'ETALONNAGE'),
  ('PRESSION',        'Pression',               90, true,  true,  true,  true,  'bar',  12, 'ETALONNAGE'),
  ('ETALON',          'Étalon / référence',    100, true,  true,  true,  true,  'mm',   24, 'ETALONNAGE'),
  ('AUTRE',           'Autre (justifié)',      900, false, false, false, false, NULL,   12, 'VERIFICATION')
ON CONFLICT (code) DO NOTHING;

/* -------------------------------------------------------------------------- */
/* 3) Registre équipement — extension                                         */
/* -------------------------------------------------------------------------- */

ALTER TABLE public.metrologie_equipements
  -- Référentiel contrôlé (le champ texte libre `categorie` reste en place pour
  -- l'historique et les écrans existants).
  ADD COLUMN IF NOT EXISTS categorie_code text NULL,
  ADD COLUMN IF NOT EXISTS sous_categorie_code text NULL,

  -- État de gouvernance. `statut` (ACTIF/INACTIF/REBUT) reste la vue héritée et
  -- est tenu à jour par trigger : aucun écran existant ne casse.
  ADD COLUMN IF NOT EXISTS etat text NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN IF NOT EXISTS etat_motif text NULL,
  ADD COLUMN IF NOT EXISTS etat_changed_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS etat_changed_by integer NULL,

  -- Propriété, responsabilité, implantation.
  ADD COLUMN IF NOT EXISTS proprietaire_service text NULL,
  ADD COLUMN IF NOT EXISTS responsable_user_id integer NULL,
  ADD COLUMN IF NOT EXISTS site text NULL,
  ADD COLUMN IF NOT EXISTS magasin text NULL,
  ADD COLUMN IF NOT EXISTS zone text NULL,
  ADD COLUMN IF NOT EXISTS localisation_precise text NULL,

  -- Cycle de vie physique.
  ADD COLUMN IF NOT EXISTS date_mise_en_service date NULL,
  ADD COLUMN IF NOT EXISTS date_retrait date NULL,

  -- Spécifications STRUCTURÉES : tout ce qui conditionne l'éligibilité est une
  -- colonne typée, jamais un blob texte.
  ADD COLUMN IF NOT EXISTS unite text NULL,
  ADD COLUMN IF NOT EXISTS plage_min numeric(18, 6) NULL,
  ADD COLUMN IF NOT EXISTS plage_max numeric(18, 6) NULL,
  ADD COLUMN IF NOT EXISTS resolution numeric(18, 6) NULL,
  ADD COLUMN IF NOT EXISTS mpe numeric(18, 6) NULL,
  ADD COLUMN IF NOT EXISTS incertitude numeric(18, 6) NULL,
  ADD COLUMN IF NOT EXISTS methodes text[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS conditions_utilisation text NULL,
  ADD COLUMN IF NOT EXISTS restrictions text NULL,
  ADD COLUMN IF NOT EXISTS etalon_reference text NULL,
  ADD COLUMN IF NOT EXISTS exige_certificat boolean NOT NULL DEFAULT false,
  -- Complément non structurant (jamais source de vérité pour l'éligibilité).
  ADD COLUMN IF NOT EXISTS specifications jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Quarantaine.
  ADD COLUMN IF NOT EXISTS quarantine_reason text NULL,
  ADD COLUMN IF NOT EXISTS quarantined_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS quarantined_by integer NULL,

  -- Dernière preuve conforme admissible : borne basse de l'analyse d'impact.
  ADD COLUMN IF NOT EXISTS last_conforme_execution_id uuid NULL,
  ADD COLUMN IF NOT EXISTS last_conforme_at timestamptz NULL;

-- Reprise de l'état à partir du statut historique, une seule fois.
UPDATE public.metrologie_equipements
SET etat = CASE statut
             WHEN 'ACTIF' THEN 'ACTIVE'
             WHEN 'INACTIF' THEN 'SUSPENDED'
             WHEN 'REBUT' THEN 'RETIRED'
             ELSE 'ACTIVE'
           END
WHERE etat = 'ACTIVE'
  AND statut <> 'ACTIF';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'metrologie_equipements_etat_229_ck'
      AND conrelid = 'public.metrologie_equipements'::regclass
  ) THEN
    ALTER TABLE public.metrologie_equipements
      ADD CONSTRAINT metrologie_equipements_etat_229_ck
      CHECK (etat IN (
        'DRAFT', 'ACTIVE', 'QUALIFIED', 'SUSPENDED',
        'QUARANTINE', 'OUT_OF_TOLERANCE', 'UNDER_REPAIR', 'RETIRED'
      ));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'metrologie_equipements_plage_229_ck'
      AND conrelid = 'public.metrologie_equipements'::regclass
  ) THEN
    ALTER TABLE public.metrologie_equipements
      ADD CONSTRAINT metrologie_equipements_plage_229_ck
      CHECK (plage_min IS NULL OR plage_max IS NULL OR plage_min <= plage_max);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'metrologie_equipements_positive_specs_229_ck'
      AND conrelid = 'public.metrologie_equipements'::regclass
  ) THEN
    ALTER TABLE public.metrologie_equipements
      ADD CONSTRAINT metrologie_equipements_positive_specs_229_ck
      CHECK (
        (resolution IS NULL OR resolution > 0)
        AND (mpe IS NULL OR mpe >= 0)
        AND (incertitude IS NULL OR incertitude >= 0)
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'metrologie_equipements_quarantine_pair_229_ck'
      AND conrelid = 'public.metrologie_equipements'::regclass
  ) THEN
    ALTER TABLE public.metrologie_equipements
      ADD CONSTRAINT metrologie_equipements_quarantine_pair_229_ck
      CHECK ((quarantined_at IS NULL) = (quarantine_reason IS NULL));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'metrologie_equipements_retrait_229_ck'
      AND conrelid = 'public.metrologie_equipements'::regclass
  ) THEN
    ALTER TABLE public.metrologie_equipements
      ADD CONSTRAINT metrologie_equipements_retrait_229_ck
      CHECK (date_retrait IS NULL OR date_mise_en_service IS NULL OR date_retrait >= date_mise_en_service);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'metrologie_equipements_categorie_229_fkey'
      AND conrelid = 'public.metrologie_equipements'::regclass
  ) THEN
    ALTER TABLE public.metrologie_equipements
      ADD CONSTRAINT metrologie_equipements_categorie_229_fkey
      FOREIGN KEY (categorie_code) REFERENCES public.metrologie_categories(code)
      ON UPDATE RESTRICT ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'metrologie_equipements_sous_categorie_229_fkey'
      AND conrelid = 'public.metrologie_equipements'::regclass
  ) THEN
    ALTER TABLE public.metrologie_equipements
      ADD CONSTRAINT metrologie_equipements_sous_categorie_229_fkey
      FOREIGN KEY (sous_categorie_code) REFERENCES public.metrologie_categories(code)
      ON UPDATE RESTRICT ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'metrologie_equipements_responsable_229_fkey'
      AND conrelid = 'public.metrologie_equipements'::regclass
  ) THEN
    ALTER TABLE public.metrologie_equipements
      ADD CONSTRAINT metrologie_equipements_responsable_229_fkey
      FOREIGN KEY (responsable_user_id) REFERENCES public.users(id)
      ON UPDATE RESTRICT ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'metrologie_equipements_quarantined_by_229_fkey'
      AND conrelid = 'public.metrologie_equipements'::regclass
  ) THEN
    ALTER TABLE public.metrologie_equipements
      ADD CONSTRAINT metrologie_equipements_quarantined_by_229_fkey
      FOREIGN KEY (quarantined_by) REFERENCES public.users(id)
      ON UPDATE RESTRICT ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'metrologie_equipements_etat_changed_by_229_fkey'
      AND conrelid = 'public.metrologie_equipements'::regclass
  ) THEN
    ALTER TABLE public.metrologie_equipements
      ADD CONSTRAINT metrologie_equipements_etat_changed_by_229_fkey
      FOREIGN KEY (etat_changed_by) REFERENCES public.users(id)
      ON UPDATE RESTRICT ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS metrologie_equipements_etat_229_idx
  ON public.metrologie_equipements (etat)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS metrologie_equipements_categorie_229_idx
  ON public.metrologie_equipements (categorie_code)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS metrologie_equipements_site_229_idx
  ON public.metrologie_equipements (site, zone)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS metrologie_equipements_serial_229_idx
  ON public.metrologie_equipements (numero_serie)
  WHERE deleted_at IS NULL;

/* -------------------------------------------------------------------------- */
/* 4) Plans métrologiques versionnés                                          */
/*                                                                            */
/*    `metrologie_plan` (1 ligne par équipement) reste la vue héritée lue par  */
/*    les écrans et KPI existants. La règle versionnée vit ici ; le miroir     */
/*    hérité est tenu à jour par l'API dans la même transaction.               */
/* -------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS public.metrologie_plan_version (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  equipement_id uuid NOT NULL
    REFERENCES public.metrologie_equipements(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  version integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'DRAFT',

  operation_type text NOT NULL,
  methode text NULL,
  procedure_ref text NULL,

  -- Règle de périodicité et base de calcul de l'échéance.
  periodicite_valeur integer NOT NULL,
  periodicite_unite text NOT NULL DEFAULT 'MONTH',
  base_calcul text NOT NULL DEFAULT 'LAST_PROOF',
  alert_window_days integer NOT NULL DEFAULT 30,

  -- Critères d'acceptation appliqués aux mesures de l'exécution.
  criteres jsonb NOT NULL DEFAULT '{}'::jsonb,
  tolerance_min numeric(18, 6) NULL,
  tolerance_max numeric(18, 6) NULL,
  unite text NULL,

  -- Qui a le droit d'exécuter, et blocage associé.
  prestataire_type text NOT NULL DEFAULT 'INTERNE',
  prestataire_label text NULL,
  fournisseur_id uuid NULL,
  role_habilite text NULL,
  criticite text NOT NULL DEFAULT 'NORMAL',
  blocking_strategy text NOT NULL DEFAULT 'BLOCK',
  exige_certificat boolean NOT NULL DEFAULT false,

  -- Dérivés serveur : dernière preuve admissible et échéance suivante.
  last_proof_execution_id uuid NULL,
  last_proof_date date NULL,
  next_due_date date NULL,

  effective_from date NULL,
  published_at timestamptz NULL,
  archived_at timestamptz NULL,
  notes text NULL,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by integer NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE SET NULL,
  updated_by integer NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE SET NULL,

  CONSTRAINT metrologie_plan_version_229_uq UNIQUE (equipement_id, operation_type, version),
  CONSTRAINT metrologie_plan_version_version_229_ck CHECK (version >= 1),
  CONSTRAINT metrologie_plan_version_status_229_ck
    CHECK (status IN ('DRAFT', 'ACTIVE', 'ARCHIVED')),
  CONSTRAINT metrologie_plan_version_operation_229_ck
    CHECK (operation_type IN ('ETALONNAGE', 'VERIFICATION')),
  CONSTRAINT metrologie_plan_version_periodicite_229_ck
    CHECK (periodicite_valeur BETWEEN 1 AND 3650),
  CONSTRAINT metrologie_plan_version_unite_229_ck
    CHECK (periodicite_unite IN ('DAY', 'WEEK', 'MONTH', 'YEAR')),
  CONSTRAINT metrologie_plan_version_base_229_ck
    CHECK (base_calcul IN ('LAST_PROOF', 'FIXED_DATE')),
  CONSTRAINT metrologie_plan_version_alert_229_ck
    CHECK (alert_window_days BETWEEN 0 AND 365),
  CONSTRAINT metrologie_plan_version_prestataire_229_ck
    CHECK (prestataire_type IN ('INTERNE', 'EXTERNE')),
  CONSTRAINT metrologie_plan_version_criticite_229_ck
    CHECK (criticite IN ('NORMAL', 'CRITIQUE')),
  CONSTRAINT metrologie_plan_version_blocking_229_ck
    CHECK (blocking_strategy IN ('BLOCK', 'WARN', 'NONE')),
  CONSTRAINT metrologie_plan_version_tolerance_229_ck
    CHECK (tolerance_min IS NULL OR tolerance_max IS NULL OR tolerance_min <= tolerance_max),
  -- Un étalonnage externe déclare son prestataire : on ne maquille pas une
  -- vérification interne en certificat externe.
  CONSTRAINT metrologie_plan_version_externe_229_ck
    CHECK (prestataire_type <> 'EXTERNE' OR prestataire_label IS NOT NULL OR fournisseur_id IS NOT NULL)
);

-- Une seule version ACTIVE par équipement et par type d'opération.
CREATE UNIQUE INDEX IF NOT EXISTS metrologie_plan_version_active_229_uq
  ON public.metrologie_plan_version (equipement_id, operation_type)
  WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS metrologie_plan_version_due_229_idx
  ON public.metrologie_plan_version (next_due_date)
  WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS metrologie_plan_version_equipement_229_idx
  ON public.metrologie_plan_version (equipement_id, status, version DESC);

/* -------------------------------------------------------------------------- */
/* 5) Exécutions : étalonnage, vérification, ajustage, réparation             */
/* -------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS public.metrologie_execution (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL,
  equipement_id uuid NOT NULL
    REFERENCES public.metrologie_equipements(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  plan_version_id uuid NULL
    REFERENCES public.metrologie_plan_version(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  plan_version integer NULL,

  operation_type text NOT NULL,
  status text NOT NULL DEFAULT 'DRAFT',

  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz NULL,

  operator_user_id integer NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE SET NULL,
  provider_label text NULL,
  fournisseur_id uuid NULL,

  methode text NULL,
  procedure_ref text NULL,
  etalon_reference text NULL,
  environnement jsonb NOT NULL DEFAULT '{}'::jsonb,
  incertitude numeric(18, 6) NULL,

  -- Verdict calculé par le domaine puis verdict retenu (override justifié).
  verdict_computed text NULL,
  verdict text NULL,
  verdict_justification text NULL,
  observations text NULL,

  decision text NULL,
  decision_reason text NULL,
  decided_by integer NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE SET NULL,
  decided_at timestamptz NULL,

  next_due_date date NULL,
  restriction text NULL,

  correlation_id uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by integer NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE SET NULL,
  updated_by integer NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE SET NULL,

  CONSTRAINT metrologie_execution_code_229_uq UNIQUE (code),
  CONSTRAINT metrologie_execution_code_229_ck CHECK (code ~ '^MEX-[0-9]{4}-[0-9]{6,}$'),
  CONSTRAINT metrologie_execution_operation_229_ck
    CHECK (operation_type IN ('ETALONNAGE', 'VERIFICATION', 'AJUSTAGE', 'REPARATION')),
  CONSTRAINT metrologie_execution_status_229_ck
    CHECK (status IN ('DRAFT', 'IN_PROGRESS', 'VALIDATED', 'CANCELLED')),
  CONSTRAINT metrologie_execution_verdict_229_ck
    CHECK (verdict IS NULL OR verdict IN ('CONFORME', 'NON_CONFORME', 'CONFORME_AVEC_RESTRICTION', 'INCONCLU')),
  CONSTRAINT metrologie_execution_verdict_computed_229_ck
    CHECK (verdict_computed IS NULL OR verdict_computed IN ('CONFORME', 'NON_CONFORME', 'CONFORME_AVEC_RESTRICTION', 'INCONCLU')),
  CONSTRAINT metrologie_execution_decision_229_ck
    CHECK (decision IS NULL OR decision IN ('REMISE_EN_SERVICE', 'QUARANTAINE', 'AJUSTAGE_REQUIS', 'REPARATION_REQUISE', 'RETRAIT')),
  -- Une exécution validée porte toujours un verdict et une décision datée.
  CONSTRAINT metrologie_execution_validated_229_ck
    CHECK (
      status <> 'VALIDATED'
      OR (verdict IS NOT NULL AND ended_at IS NOT NULL AND decided_at IS NOT NULL AND decided_by IS NOT NULL)
    ),
  CONSTRAINT metrologie_execution_restriction_229_ck
    CHECK (verdict <> 'CONFORME_AVEC_RESTRICTION' OR restriction IS NOT NULL),
  CONSTRAINT metrologie_execution_dates_229_ck
    CHECK (ended_at IS NULL OR ended_at >= started_at),
  -- Un étalonnage/vérification s'adosse à une version de plan ; un ajustage ou
  -- une réparation est une intervention technique qui peut s'en passer.
  CONSTRAINT metrologie_execution_plan_229_ck
    CHECK (operation_type IN ('AJUSTAGE', 'REPARATION') OR plan_version_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS metrologie_execution_equipement_229_idx
  ON public.metrologie_execution (equipement_id, started_at DESC);

CREATE INDEX IF NOT EXISTS metrologie_execution_status_229_idx
  ON public.metrologie_execution (status, verdict);

CREATE INDEX IF NOT EXISTS metrologie_execution_proof_229_idx
  ON public.metrologie_execution (equipement_id, ended_at DESC)
  WHERE status = 'VALIDATED' AND verdict IN ('CONFORME', 'CONFORME_AVEC_RESTRICTION');

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'metrologie_equipements_last_conforme_229_fkey'
      AND conrelid = 'public.metrologie_equipements'::regclass
  ) THEN
    ALTER TABLE public.metrologie_equipements
      ADD CONSTRAINT metrologie_equipements_last_conforme_229_fkey
      FOREIGN KEY (last_conforme_execution_id) REFERENCES public.metrologie_execution(id)
      ON UPDATE RESTRICT ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'metrologie_plan_version_last_proof_229_fkey'
      AND conrelid = 'public.metrologie_plan_version'::regclass
  ) THEN
    ALTER TABLE public.metrologie_plan_version
      ADD CONSTRAINT metrologie_plan_version_last_proof_229_fkey
      FOREIGN KEY (last_proof_execution_id) REFERENCES public.metrologie_execution(id)
      ON UPDATE RESTRICT ON DELETE SET NULL;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.metrologie_execution_measurement (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id uuid NOT NULL
    REFERENCES public.metrologie_execution(id) ON UPDATE RESTRICT ON DELETE CASCADE,
  point_key text NOT NULL,
  label text NULL,
  sample_no integer NOT NULL DEFAULT 1,

  nominal numeric(18, 6) NULL,
  tolerance_min numeric(18, 6) NULL,
  tolerance_max numeric(18, 6) NULL,
  measured numeric(18, 6) NULL,
  unite text NULL,
  incertitude numeric(18, 6) NULL,
  ecart numeric(18, 6) NULL,

  verdict text NULL,
  comment text NULL,
  revision integer NOT NULL DEFAULT 1,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by integer NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE SET NULL,
  updated_by integer NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE SET NULL,

  CONSTRAINT metrologie_measurement_229_uq UNIQUE (execution_id, point_key, sample_no),
  CONSTRAINT metrologie_measurement_sample_229_ck CHECK (sample_no >= 1),
  CONSTRAINT metrologie_measurement_revision_229_ck CHECK (revision >= 1),
  CONSTRAINT metrologie_measurement_tolerance_229_ck
    CHECK (tolerance_min IS NULL OR tolerance_max IS NULL OR tolerance_min <= tolerance_max),
  CONSTRAINT metrologie_measurement_verdict_229_ck
    CHECK (verdict IS NULL OR verdict IN ('CONFORME', 'NON_CONFORME', 'INCONCLU'))
);

CREATE INDEX IF NOT EXISTS metrologie_measurement_execution_229_idx
  ON public.metrologie_execution_measurement (execution_id, point_key, sample_no);

-- Historique append-only des corrections de mesure : on n'écrase jamais une
-- valeur relevée, on empile une révision motivée.
CREATE TABLE IF NOT EXISTS public.metrologie_measurement_revision (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  measurement_id uuid NOT NULL
    REFERENCES public.metrologie_execution_measurement(id) ON UPDATE RESTRICT ON DELETE CASCADE,
  revision integer NOT NULL,
  previous_values jsonb NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by integer NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE SET NULL,

  CONSTRAINT metrologie_measurement_revision_229_uq UNIQUE (measurement_id, revision),
  CONSTRAINT metrologie_measurement_revision_reason_229_ck CHECK (char_length(btrim(reason)) >= 5)
);

/* -------------------------------------------------------------------------- */
/* 6) Certificats et PV — extension                                           */
/* -------------------------------------------------------------------------- */

ALTER TABLE public.metrologie_certificats
  ADD COLUMN IF NOT EXISTS execution_id uuid NULL,
  ADD COLUMN IF NOT EXISTS document_kind text NOT NULL DEFAULT 'CERTIFICAT',
  ADD COLUMN IF NOT EXISTS numero_externe text NULL,
  ADD COLUMN IF NOT EXISTS emetteur text NULL,
  ADD COLUMN IF NOT EXISTS couverture jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS statut text NOT NULL DEFAULT 'VALIDE',
  ADD COLUMN IF NOT EXISTS cancel_reason text NULL,
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS cancelled_by integer NULL,
  ADD COLUMN IF NOT EXISTS replaced_by_id uuid NULL,
  ADD COLUMN IF NOT EXISTS confidentiality text NOT NULL DEFAULT 'RESTRICTED';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'metrologie_certificats_kind_229_ck'
      AND conrelid = 'public.metrologie_certificats'::regclass
  ) THEN
    ALTER TABLE public.metrologie_certificats
      ADD CONSTRAINT metrologie_certificats_kind_229_ck
      CHECK (document_kind IN ('CERTIFICAT', 'PV_INTERNE', 'RAPPORT', 'AUTRE'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'metrologie_certificats_statut_229_ck'
      AND conrelid = 'public.metrologie_certificats'::regclass
  ) THEN
    ALTER TABLE public.metrologie_certificats
      ADD CONSTRAINT metrologie_certificats_statut_229_ck
      CHECK (statut IN ('VALIDE', 'ANNULE', 'REMPLACE'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'metrologie_certificats_cancel_pair_229_ck'
      AND conrelid = 'public.metrologie_certificats'::regclass
  ) THEN
    ALTER TABLE public.metrologie_certificats
      ADD CONSTRAINT metrologie_certificats_cancel_pair_229_ck
      CHECK (statut <> 'ANNULE' OR (cancel_reason IS NOT NULL AND cancelled_at IS NOT NULL));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'metrologie_certificats_confidentiality_229_ck'
      AND conrelid = 'public.metrologie_certificats'::regclass
  ) THEN
    ALTER TABLE public.metrologie_certificats
      ADD CONSTRAINT metrologie_certificats_confidentiality_229_ck
      CHECK (confidentiality IN ('INTERNAL', 'RESTRICTED', 'CUSTOMER_VISIBLE'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'metrologie_certificats_execution_229_fkey'
      AND conrelid = 'public.metrologie_certificats'::regclass
  ) THEN
    ALTER TABLE public.metrologie_certificats
      ADD CONSTRAINT metrologie_certificats_execution_229_fkey
      FOREIGN KEY (execution_id) REFERENCES public.metrologie_execution(id)
      ON UPDATE RESTRICT ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'metrologie_certificats_replaced_by_229_fkey'
      AND conrelid = 'public.metrologie_certificats'::regclass
  ) THEN
    ALTER TABLE public.metrologie_certificats
      ADD CONSTRAINT metrologie_certificats_replaced_by_229_fkey
      FOREIGN KEY (replaced_by_id) REFERENCES public.metrologie_certificats(id)
      ON UPDATE RESTRICT ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'metrologie_certificats_cancelled_by_229_fkey'
      AND conrelid = 'public.metrologie_certificats'::regclass
  ) THEN
    ALTER TABLE public.metrologie_certificats
      ADD CONSTRAINT metrologie_certificats_cancelled_by_229_fkey
      FOREIGN KEY (cancelled_by) REFERENCES public.users(id)
      ON UPDATE RESTRICT ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS metrologie_certificats_execution_229_idx
  ON public.metrologie_certificats (execution_id);

CREATE UNIQUE INDEX IF NOT EXISTS metrologie_certificats_numero_externe_229_uq
  ON public.metrologie_certificats (emetteur, numero_externe)
  WHERE numero_externe IS NOT NULL AND emetteur IS NOT NULL AND deleted_at IS NULL;

/* -------------------------------------------------------------------------- */
/* 7) Analyse d'impact bornée                                                 */
/*                                                                            */
/*    Un dossier = un périmètre explicite (fenêtre temporelle bornée par la    */
/*    dernière preuve conforme) + une liste explicable d'usages. Il ne         */
/*    présume aucune non-conformité produit et ne déclenche AUCUNE action      */
/*    automatique sur les contrôles, OF, lots, BL ou factures.                 */
/* -------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS public.metrologie_impact_dossier (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL,
  equipement_id uuid NOT NULL
    REFERENCES public.metrologie_equipements(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  execution_id uuid NULL
    REFERENCES public.metrologie_execution(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  certificat_id uuid NULL
    REFERENCES public.metrologie_certificats(id) ON UPDATE RESTRICT ON DELETE RESTRICT,

  trigger_type text NOT NULL,
  status text NOT NULL DEFAULT 'OPEN',
  priority text NOT NULL DEFAULT 'NORMAL',

  -- Fenêtre d'analyse : bornée, jamais ouverte.
  window_from timestamptz NOT NULL,
  window_to timestamptz NOT NULL,
  window_source text NOT NULL DEFAULT 'LAST_CONFORME_PROOF',

  method text NOT NULL,
  scope jsonb NOT NULL DEFAULT '{}'::jsonb,
  exclusions text NULL,
  volumes jsonb NOT NULL DEFAULT '{}'::jsonb,
  truncated boolean NOT NULL DEFAULT false,

  owner_user_id integer NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE SET NULL,
  conclusion text NULL,
  closed_at timestamptz NULL,
  closed_by integer NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE SET NULL,

  correlation_id uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by integer NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE SET NULL,
  updated_by integer NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE SET NULL,

  CONSTRAINT metrologie_impact_dossier_code_229_uq UNIQUE (code),
  CONSTRAINT metrologie_impact_dossier_code_229_ck CHECK (code ~ '^MIA-[0-9]{4}-[0-9]{5,}$'),
  CONSTRAINT metrologie_impact_dossier_trigger_229_ck
    CHECK (trigger_type IN ('VERDICT_NON_CONFORME', 'CERTIFICAT_INVALIDE', 'MANUEL')),
  CONSTRAINT metrologie_impact_dossier_status_229_ck
    CHECK (status IN ('OPEN', 'IN_REVIEW', 'CLOSED', 'CANCELLED')),
  CONSTRAINT metrologie_impact_dossier_priority_229_ck
    CHECK (priority IN ('LOW', 'NORMAL', 'HIGH', 'CRITICAL')),
  CONSTRAINT metrologie_impact_dossier_window_229_ck CHECK (window_to >= window_from),
  CONSTRAINT metrologie_impact_dossier_window_source_229_ck
    CHECK (window_source IN ('LAST_CONFORME_PROOF', 'APPROVED_WINDOW', 'EQUIPMENT_CREATION')),
  CONSTRAINT metrologie_impact_dossier_closed_229_ck
    CHECK (status <> 'CLOSED' OR (closed_at IS NOT NULL AND closed_by IS NOT NULL AND conclusion IS NOT NULL))
);

-- Un seul dossier ouvert par exécution déclenchante : garantit l'idempotence de
-- la transaction « hors tolérance ».
CREATE UNIQUE INDEX IF NOT EXISTS metrologie_impact_dossier_execution_229_uq
  ON public.metrologie_impact_dossier (execution_id)
  WHERE execution_id IS NOT NULL AND status <> 'CANCELLED';

CREATE INDEX IF NOT EXISTS metrologie_impact_dossier_equipement_229_idx
  ON public.metrologie_impact_dossier (equipement_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS public.metrologie_impact_item (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dossier_id uuid NOT NULL
    REFERENCES public.metrologie_impact_dossier(id) ON UPDATE RESTRICT ON DELETE CASCADE,

  quality_control_id uuid NULL
    REFERENCES public.quality_control(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  control_reference text NULL,
  control_type text NULL,
  control_date timestamptz NULL,
  characteristic_key text NULL,

  -- Références souples vers les autres modules (même convention que
  -- `quality_control` : pas de FK, pour ne jamais bloquer un module tiers).
  of_id bigint NULL,
  lot_id uuid NULL,
  bon_livraison_id uuid NULL,
  article_id uuid NULL,
  affaire_id bigint NULL,

  decision text NOT NULL DEFAULT 'PENDING',
  decision_reason text NULL,
  decided_by integer NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE SET NULL,
  decided_at timestamptz NULL,
  non_conformity_id uuid NULL,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT metrologie_impact_item_control_229_uq UNIQUE (dossier_id, quality_control_id, characteristic_key),
  CONSTRAINT metrologie_impact_item_decision_229_ck
    CHECK (decision IN (
      'PENDING', 'NO_IMPACT', 'RECHECK', 'HOLD_LOT',
      'OPEN_NC', 'REISSUE_DOCUMENT', 'INFORM_CUSTOMER'
    )),
  -- Une décision autre que « à traiter » est motivée, datée et attribuée.
  CONSTRAINT metrologie_impact_item_decided_229_ck
    CHECK (
      decision = 'PENDING'
      OR (decided_by IS NOT NULL AND decided_at IS NOT NULL AND char_length(btrim(COALESCE(decision_reason, ''))) >= 5)
    )
);

CREATE INDEX IF NOT EXISTS metrologie_impact_item_dossier_229_idx
  ON public.metrologie_impact_item (dossier_id, decision, control_date DESC);

CREATE INDEX IF NOT EXISTS metrologie_impact_item_of_229_idx
  ON public.metrologie_impact_item (of_id);

CREATE INDEX IF NOT EXISTS metrologie_impact_item_lot_229_idx
  ON public.metrologie_impact_item (lot_id);

CREATE INDEX IF NOT EXISTS metrologie_impact_item_bl_229_idx
  ON public.metrologie_impact_item (bon_livraison_id);

/* -------------------------------------------------------------------------- */
/* 8) Idempotence, audit et journal                                           */
/* -------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS public.metrologie_command_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id integer NOT NULL
    REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  command_type text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  request_payload jsonb NOT NULL,
  result_payload jsonb NOT NULL,
  correlation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT metrologie_command_receipts_229_uq UNIQUE (actor_user_id, idempotency_key),
  CONSTRAINT metrologie_command_receipts_key_229_ck
    CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
  CONSTRAINT metrologie_command_receipts_hash_229_ck CHECK (request_hash ~ '^[A-Fa-f0-9]{64}$'),
  CONSTRAINT metrologie_command_receipts_type_229_ck
    CHECK (char_length(command_type) BETWEEN 3 AND 120),
  CONSTRAINT metrologie_command_receipts_aggregate_229_ck
    CHECK (aggregate_type IN ('EQUIPEMENT', 'CATEGORIE', 'PLAN', 'EXECUTION', 'CERTIFICAT', 'IMPACT'))
);

CREATE INDEX IF NOT EXISTS metrologie_command_receipts_resource_229_idx
  ON public.metrologie_command_receipts (aggregate_type, aggregate_id, created_at DESC);

ALTER TABLE public.metrologie_event_log
  ADD COLUMN IF NOT EXISTS entity_type text NULL,
  ADD COLUMN IF NOT EXISTS entity_id text NULL,
  ADD COLUMN IF NOT EXISTS correlation_id uuid NULL,
  ADD COLUMN IF NOT EXISTS idempotency_key text NULL,
  ADD COLUMN IF NOT EXISTS rule_code text NULL,
  ADD COLUMN IF NOT EXISTS reason text NULL,
  ADD COLUMN IF NOT EXISTS request_id text NULL,
  ADD COLUMN IF NOT EXISTS source text NULL;

CREATE INDEX IF NOT EXISTS metrologie_event_log_correlation_229_idx
  ON public.metrologie_event_log (correlation_id);

CREATE INDEX IF NOT EXISTS metrologie_event_log_entity_229_idx
  ON public.metrologie_event_log (entity_type, entity_id, created_at DESC);

-- Réglage historique : la portée est documentée en base pour lever toute
-- ambiguïté. Il reste `false` par défaut et n'est JAMAIS un verrou global.
UPDATE public.erp_settings
SET value_json = COALESCE(value_json, '{}'::jsonb) || jsonb_build_object(
      'scope', 'PER_INSTRUMENT',
      'applies_to', 'CRITICAL_OVERDUE_ONLY',
      'documented_by', '#229'
    ),
    updated_at = now()
WHERE key = 'metrologie.block_on_overdue_critical'
  AND NOT (COALESCE(value_json, '{}'::jsonb) ? 'scope');

/* -------------------------------------------------------------------------- */
/* 9) Immuabilité, append-only et cohérence héritée                           */
/* -------------------------------------------------------------------------- */

-- Le code visible d'un équipement est immuable une fois attribué, et un
-- équipement déjà utilisé par un contrôle qualité, une exécution ou un dossier
-- d'impact ne se supprime jamais physiquement.
CREATE OR REPLACE FUNCTION public.fn_protect_metrologie_equipement_229()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_used bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT COUNT(*) INTO v_used
    FROM public.quality_control_points
    WHERE instrument_id = OLD.id;
    IF v_used > 0 THEN
      RAISE EXCEPTION 'metrologie equipement % is referenced by % quality measurement(s): archive it instead', OLD.id, v_used;
    END IF;

    SELECT COUNT(*) INTO v_used FROM public.metrologie_execution WHERE equipement_id = OLD.id;
    IF v_used > 0 THEN
      RAISE EXCEPTION 'metrologie equipement % carries % execution(s): archive it instead', OLD.id, v_used;
    END IF;

    SELECT COUNT(*) INTO v_used FROM public.metrologie_impact_dossier WHERE equipement_id = OLD.id;
    IF v_used > 0 THEN
      RAISE EXCEPTION 'metrologie equipement % carries % impact dossier(s): archive it instead', OLD.id, v_used;
    END IF;

    RETURN OLD;
  END IF;

  IF OLD.code IS NOT NULL AND NEW.code IS DISTINCT FROM OLD.code THEN
    RAISE EXCEPTION 'metrologie equipement code is immutable once issued (% -> %)', OLD.code, NEW.code;
  END IF;

  -- Miroir hérité : `statut` reste cohérent avec l'état de gouvernance pour ne
  -- casser ni les KPI ni les écrans déjà en production. La synchronisation est
  -- bidirectionnelle : le routeur historique (qui ne connaît que `statut`) ne
  -- peut pas laisser les deux colonnes diverger.
  IF NEW.etat IS DISTINCT FROM OLD.etat THEN
    NEW.statut := CASE NEW.etat
                    WHEN 'ACTIVE' THEN 'ACTIF'
                    WHEN 'QUALIFIED' THEN 'ACTIF'
                    WHEN 'RETIRED' THEN 'REBUT'
                    ELSE 'INACTIF'
                  END;
  ELSIF NEW.statut IS DISTINCT FROM OLD.statut THEN
    NEW.etat := CASE NEW.statut
                  WHEN 'ACTIF' THEN
                    -- Une remise en service ne sort JAMAIS d'une quarantaine ou
                    -- d'un hors tolérance par simple changement de statut.
                    CASE WHEN OLD.etat IN ('QUARANTINE', 'OUT_OF_TOLERANCE', 'UNDER_REPAIR')
                         THEN OLD.etat ELSE 'ACTIVE' END
                  WHEN 'REBUT' THEN 'RETIRED'
                  ELSE
                    CASE WHEN OLD.etat IN ('QUARANTINE', 'OUT_OF_TOLERANCE', 'UNDER_REPAIR')
                         THEN OLD.etat ELSE 'SUSPENDED' END
                END;
    -- Le statut hérité est recalculé depuis l'état retenu pour rester cohérent
    -- lorsque la quarantaine a été préservée.
    NEW.statut := CASE NEW.etat
                    WHEN 'ACTIVE' THEN 'ACTIF'
                    WHEN 'QUALIFIED' THEN 'ACTIF'
                    WHEN 'RETIRED' THEN 'REBUT'
                    ELSE 'INACTIF'
                  END;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_metrologie_equipement_229 ON public.metrologie_equipements;
CREATE TRIGGER trg_protect_metrologie_equipement_229
  BEFORE UPDATE OR DELETE ON public.metrologie_equipements
  FOR EACH ROW EXECUTE FUNCTION public.fn_protect_metrologie_equipement_229();

-- Une version de plan ACTIVE ou ARCHIVED est figée : seuls les dérivés
-- (dernière preuve, échéance) et le statut évoluent. Toute autre modification
-- exige une nouvelle version.
CREATE OR REPLACE FUNCTION public.fn_protect_metrologie_plan_version_229()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'an active or archived metrology plan version is immutable and cannot be deleted';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status IN ('ACTIVE', 'ARCHIVED') THEN
    IF NEW.version <> OLD.version
      OR NEW.equipement_id <> OLD.equipement_id
      OR NEW.operation_type <> OLD.operation_type
      OR NEW.periodicite_valeur <> OLD.periodicite_valeur
      OR NEW.periodicite_unite <> OLD.periodicite_unite
      OR NEW.base_calcul <> OLD.base_calcul
      OR NEW.criteres::text <> OLD.criteres::text
      OR COALESCE(NEW.methode, '') <> COALESCE(OLD.methode, '')
      OR COALESCE(NEW.procedure_ref, '') <> COALESCE(OLD.procedure_ref, '')
      OR COALESCE(NEW.tolerance_min, -1e18) <> COALESCE(OLD.tolerance_min, -1e18)
      OR COALESCE(NEW.tolerance_max, -1e18) <> COALESCE(OLD.tolerance_max, -1e18)
      OR NEW.prestataire_type <> OLD.prestataire_type
      OR NEW.criticite <> OLD.criticite
      OR NEW.blocking_strategy <> OLD.blocking_strategy
      OR NEW.exige_certificat <> OLD.exige_certificat
      OR COALESCE(NEW.effective_from::text, '') <> COALESCE(OLD.effective_from::text, '')
    THEN
      RAISE EXCEPTION 'metrology plan version %/% is frozen: create a new version', OLD.equipement_id, OLD.version;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_metrologie_plan_version_229 ON public.metrologie_plan_version;
CREATE TRIGGER trg_protect_metrologie_plan_version_229
  BEFORE UPDATE OR DELETE ON public.metrologie_plan_version
  FOR EACH ROW EXECUTE FUNCTION public.fn_protect_metrologie_plan_version_229();

-- Une exécution validée ne se réécrit pas : ni son verdict, ni ses dates, ni
-- son opérateur. Elle ne se supprime jamais.
CREATE OR REPLACE FUNCTION public.fn_protect_metrologie_execution_229()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a metrology execution is an audit record and cannot be deleted';
  END IF;

  IF NEW.code IS DISTINCT FROM OLD.code THEN
    RAISE EXCEPTION 'metrology execution code is immutable';
  END IF;

  IF OLD.status = 'VALIDATED' THEN
    IF NEW.verdict IS DISTINCT FROM OLD.verdict
      OR NEW.verdict_computed IS DISTINCT FROM OLD.verdict_computed
      OR NEW.status <> OLD.status
      OR NEW.operation_type <> OLD.operation_type
      OR NEW.equipement_id <> OLD.equipement_id
      OR NEW.started_at IS DISTINCT FROM OLD.started_at
      OR NEW.ended_at IS DISTINCT FROM OLD.ended_at
      OR NEW.operator_user_id IS DISTINCT FROM OLD.operator_user_id
      OR NEW.decision IS DISTINCT FROM OLD.decision
      OR NEW.decided_by IS DISTINCT FROM OLD.decided_by
      OR NEW.decided_at IS DISTINCT FROM OLD.decided_at
    THEN
      RAISE EXCEPTION 'a validated metrology execution is immutable';
    END IF;
  END IF;

  IF OLD.status = 'CANCELLED' AND NEW.status <> 'CANCELLED' THEN
    RAISE EXCEPTION 'a cancelled metrology execution cannot be reopened';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_metrologie_execution_229 ON public.metrologie_execution;
CREATE TRIGGER trg_protect_metrologie_execution_229
  BEFORE UPDATE OR DELETE ON public.metrologie_execution
  FOR EACH ROW EXECUTE FUNCTION public.fn_protect_metrologie_execution_229();

-- Une mesure rattachée à une exécution validée est figée ; une correction passe
-- par une révision motivée (append-only).
CREATE OR REPLACE FUNCTION public.fn_protect_metrologie_measurement_229()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_status text;
BEGIN
  SELECT status INTO v_status
  FROM public.metrologie_execution
  WHERE id = COALESCE(NEW.execution_id, OLD.execution_id);

  IF v_status = 'VALIDATED' THEN
    RAISE EXCEPTION 'measurements of a validated metrology execution are immutable';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.revision <= OLD.revision THEN
    RAISE EXCEPTION 'a metrology measurement correction must increment its revision';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_metrologie_measurement_229 ON public.metrologie_execution_measurement;
CREATE TRIGGER trg_protect_metrologie_measurement_229
  BEFORE UPDATE OR DELETE ON public.metrologie_execution_measurement
  FOR EACH ROW EXECUTE FUNCTION public.fn_protect_metrologie_measurement_229();

-- Un certificat est une preuve : il s'annule ou se remplace avec motif, il ne
-- se réécrit pas et ne se supprime pas physiquement.
CREATE OR REPLACE FUNCTION public.fn_protect_metrologie_certificat_229()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a metrology certificate is evidence and cannot be hard-deleted';
  END IF;

  IF NEW.sha256 IS DISTINCT FROM OLD.sha256 AND OLD.sha256 IS NOT NULL THEN
    RAISE EXCEPTION 'the SHA-256 fingerprint of a metrology certificate is immutable';
  END IF;
  IF NEW.date_etalonnage IS DISTINCT FROM OLD.date_etalonnage AND OLD.deleted_at IS NULL AND OLD.statut = 'VALIDE' AND NEW.statut = 'VALIDE' THEN
    RAISE EXCEPTION 'the calibration date of a valid certificate is immutable: cancel and replace it';
  END IF;
  IF OLD.statut IN ('ANNULE', 'REMPLACE') AND NEW.statut = 'VALIDE' THEN
    RAISE EXCEPTION 'a cancelled or superseded certificate never becomes valid again';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_metrologie_certificat_229 ON public.metrologie_certificats;
CREATE TRIGGER trg_protect_metrologie_certificat_229
  BEFORE UPDATE OR DELETE ON public.metrologie_certificats
  FOR EACH ROW EXECUTE FUNCTION public.fn_protect_metrologie_certificat_229();

-- Journal et reçus : strictement append-only.
CREATE OR REPLACE FUNCTION public.fn_metrologie_append_only_229()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;

DROP TRIGGER IF EXISTS trg_metrologie_event_log_append_only_229 ON public.metrologie_event_log;
CREATE TRIGGER trg_metrologie_event_log_append_only_229
  BEFORE UPDATE OR DELETE ON public.metrologie_event_log
  FOR EACH ROW EXECUTE FUNCTION public.fn_metrologie_append_only_229();

DROP TRIGGER IF EXISTS trg_metrologie_receipts_append_only_229 ON public.metrologie_command_receipts;
CREATE TRIGGER trg_metrologie_receipts_append_only_229
  BEFORE UPDATE OR DELETE ON public.metrologie_command_receipts
  FOR EACH ROW EXECUTE FUNCTION public.fn_metrologie_append_only_229();

DROP TRIGGER IF EXISTS trg_metrologie_measurement_revision_append_only_229 ON public.metrologie_measurement_revision;
CREATE TRIGGER trg_metrologie_measurement_revision_append_only_229
  BEFORE UPDATE OR DELETE ON public.metrologie_measurement_revision
  FOR EACH ROW EXECUTE FUNCTION public.fn_metrologie_append_only_229();

-- Une catégorie utilisée se désactive, elle ne se supprime pas.
CREATE OR REPLACE FUNCTION public.fn_protect_metrologie_categorie_229()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_used bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT COUNT(*) INTO v_used
    FROM public.metrologie_equipements
    WHERE categorie_code = OLD.code OR sous_categorie_code = OLD.code;
    IF v_used > 0 THEN
      RAISE EXCEPTION 'metrology category % is used by % equipment(s): deactivate it instead', OLD.code, v_used;
    END IF;
    RETURN OLD;
  END IF;

  IF NEW.code <> OLD.code THEN
    RAISE EXCEPTION 'metrology category code is immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_metrologie_categorie_229 ON public.metrologie_categories;
CREATE TRIGGER trg_protect_metrologie_categorie_229
  BEFORE UPDATE OR DELETE ON public.metrologie_categories
  FOR EACH ROW EXECUTE FUNCTION public.fn_protect_metrologie_categorie_229();

-- Un dossier d'impact clos est figé.
CREATE OR REPLACE FUNCTION public.fn_protect_metrologie_impact_229()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a metrology impact dossier is an audit record and cannot be deleted';
  END IF;
  IF OLD.status = 'CLOSED' AND NEW.status <> 'CLOSED' THEN
    RAISE EXCEPTION 'a closed metrology impact dossier cannot be reopened';
  END IF;
  IF NEW.code IS DISTINCT FROM OLD.code THEN
    RAISE EXCEPTION 'metrology impact dossier code is immutable';
  END IF;
  IF NEW.window_from IS DISTINCT FROM OLD.window_from OR NEW.window_to IS DISTINCT FROM OLD.window_to THEN
    RAISE EXCEPTION 'the analysis window of an impact dossier is immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_metrologie_impact_229 ON public.metrologie_impact_dossier;
CREATE TRIGGER trg_protect_metrologie_impact_229
  BEFORE UPDATE OR DELETE ON public.metrologie_impact_dossier
  FOR EACH ROW EXECUTE FUNCTION public.fn_protect_metrologie_impact_229();

-- Une décision d'impact prise est définitive : on en reprend une nouvelle,
-- on ne la réécrit pas silencieusement.
CREATE OR REPLACE FUNCTION public.fn_protect_metrologie_impact_item_229()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a metrology impact item is an audit record and cannot be deleted';
  END IF;
  IF OLD.decision <> 'PENDING' AND NEW.decision IS DISTINCT FROM OLD.decision THEN
    RAISE EXCEPTION 'a metrology impact decision is final (% already decided)', OLD.id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_metrologie_impact_item_229 ON public.metrologie_impact_item;
CREATE TRIGGER trg_protect_metrologie_impact_item_229
  BEFORE UPDATE OR DELETE ON public.metrologie_impact_item
  FOR EACH ROW EXECUTE FUNCTION public.fn_protect_metrologie_impact_item_229();

/* -------------------------------------------------------------------------- */
/* 10) Commentaires                                                           */
/* -------------------------------------------------------------------------- */

COMMENT ON TABLE public.metrologie_categories IS
  '#229 — Référentiel administré des catégories de moyens de mesure. Désactivation, jamais suppression, quand la catégorie est utilisée.';
COMMENT ON TABLE public.metrologie_plan_version IS
  '#229 — Règle métrologique versionnée (périodicité, méthode, tolérances, habilitation). Une version ACTIVE ou ARCHIVED est figée.';
COMMENT ON TABLE public.metrologie_execution IS
  '#229 — Étalonnage, vérification, ajustage ou réparation. Une exécution validée est immuable et ne se supprime pas.';
COMMENT ON TABLE public.metrologie_impact_dossier IS
  '#229 — Analyse d''impact BORNÉE depuis la dernière preuve conforme. Ne déclenche aucune action automatique sur contrôles, OF, lots, BL ou factures.';
COMMENT ON COLUMN public.metrologie_equipements.etat IS
  '#229 — État de gouvernance serveur. DUE_SOON/OVERDUE ne sont PAS stockés : ils sont dérivés du plan actif pour ne jamais dériver de la réalité.';
COMMENT ON COLUMN public.metrologie_equipements.statut IS
  'Statut hérité (ACTIF/INACTIF/REBUT) conservé pour les écrans existants, tenu à jour par trigger depuis `etat` (#229).';

COMMIT;
