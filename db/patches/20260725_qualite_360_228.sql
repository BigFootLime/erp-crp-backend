-- 20260725_qualite_360_228.sql
-- Issue #228 — Qualité industrielle 360 : plans de contrôle versionnés,
-- exécutions/mesures tracées, libération partielle, non-conformités
-- structurées, dérogations/concessions et CAPA.
--
-- Propriétés du patch :
--   * ADDITIF uniquement : aucune table/colonne/contrainte existante supprimée,
--     aucune donnée historique modifiée, aucune valeur d'enum retirée.
--   * IDEMPOTENT : rejouable sans effet de bord.
--   * TRANSACTIONNEL : BEGIN/COMMIT, rien de partiel.
--   * INACTIF : ne crée aucun plan, aucune dérogation, aucune libération et ne
--     modifie aucun statut de lot. Le module reste piloté par l'API.
--   * Les enums historiques (`quality_nc_status`, `quality_entity_type`) sont
--     ÉTENDUS, jamais dupliqués par une seconde nomenclature.
--
-- Prérequis : PostgreSQL 12+ (ALTER TYPE ... ADD VALUE dans une transaction).
-- Les valeurs d'enum ajoutées ici ne sont volontairement PAS utilisées dans
-- cette même transaction (contrainte PostgreSQL documentée).

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.quality_control') IS NULL THEN
    RAISE EXCEPTION '#228 requires the Qualité baseline (20260213_qualite_module.sql)';
  END IF;
  IF to_regclass('public.non_conformity') IS NULL THEN
    RAISE EXCEPTION '#228 requires public.non_conformity';
  END IF;
  IF to_regclass('public.users') IS NULL THEN
    RAISE EXCEPTION '#228 requires public.users';
  END IF;
  IF to_regprocedure('public.fn_next_issued_code_value(text)') IS NULL THEN
    RAISE EXCEPTION '#228: public.fn_next_issued_code_value(text) is missing — apply 20260713_codification_versions_of_vsm.sql first';
  END IF;
END $$;

/* -------------------------------------------------------------------------- */
/* 0) Codification : ajoute les périmètres PC et DER à l'allocateur whitelisté */
/*    Corps identique à 20260713/20260721 — SEUL le regex gagne |PC|DER.       */
/* -------------------------------------------------------------------------- */

CREATE OR REPLACE FUNCTION public.fn_next_issued_code_value(p_scope text)
RETURNS bigint
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
  v_scope text := upper(btrim(COALESCE(p_scope, '')));
BEGIN
  IF v_scope !~ '^(CLI|FOU|ART:[A-Z0-9]{1,48}|(DEV|CMD|AFF|OF|LOT|MVT|CQ|NC|CAPA|BL|FACT|BCF|PC|DER):[0-9]{4})$' THEN
    RAISE EXCEPTION 'Unsupported business-code sequence scope: %', p_scope
      USING ERRCODE = '22023';
  END IF;
  RETURN nextval('public.cerp_business_code_issue_seq'::regclass);
END;
$$;

COMMENT ON FUNCTION public.fn_next_issued_code_value(text) IS
  'Whitelisted, non-reusable business-code allocator backed by a native PostgreSQL sequence. #228 adds the PC (plans de contrôle) and DER (dérogations) scopes.';

/* -------------------------------------------------------------------------- */
/* 1) Extension additive des enums historiques                                */
/* -------------------------------------------------------------------------- */

DO $$
BEGIN
  -- Cycle de vie NC complet demandé par #228, en conservant OPEN/ANALYSIS/
  -- ACTION_PLAN/CLOSED déjà utilisés en production.
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'quality_nc_status') THEN
    ALTER TYPE public.quality_nc_status ADD VALUE IF NOT EXISTS 'DRAFT';
    ALTER TYPE public.quality_nc_status ADD VALUE IF NOT EXISTS 'DISPOSITION';
    ALTER TYPE public.quality_nc_status ADD VALUE IF NOT EXISTS 'VERIFICATION';
    ALTER TYPE public.quality_nc_status ADD VALUE IF NOT EXISTS 'CANCELLED';
  END IF;

  -- Nouvelles entités porteuses de documents et d'événements qualité.
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'quality_entity_type') THEN
    ALTER TYPE public.quality_entity_type ADD VALUE IF NOT EXISTS 'PLAN';
    ALTER TYPE public.quality_entity_type ADD VALUE IF NOT EXISTS 'DEROGATION';
    ALTER TYPE public.quality_entity_type ADD VALUE IF NOT EXISTS 'RELEASE';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'quality_document_type') THEN
    ALTER TYPE public.quality_document_type ADD VALUE IF NOT EXISTS 'PLAN';
    ALTER TYPE public.quality_document_type ADD VALUE IF NOT EXISTS 'DEROGATION';
  END IF;
END $$;

/* -------------------------------------------------------------------------- */
/* 2) Plans de contrôle versionnés                                            */
/* -------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS public.quality_control_plan (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  label text NOT NULL,
  status text NOT NULL DEFAULT 'DRAFT',

  trigger_type text NOT NULL,

  -- Périmètre d'applicabilité (axes optionnels, au moins un axe produit).
  article_id uuid NULL,
  piece_technique_id uuid NULL,
  piece_version_id uuid NULL,
  famille_id uuid NULL,
  operation_code text NULL,
  fournisseur_id uuid NULL,

  sampling_rule text NOT NULL DEFAULT 'ALL',
  sampling_value numeric(12, 4) NULL,
  sampling_justification text NULL,

  owner_user_id integer NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE SET NULL,
  revision_reason text NULL,
  effective_from timestamptz NULL,
  effective_to timestamptz NULL,

  supersedes_plan_id uuid NULL REFERENCES public.quality_control_plan(id) ON UPDATE RESTRICT ON DELETE SET NULL,

  submitted_at timestamptz NULL,
  submitted_by integer NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE SET NULL,
  published_at timestamptz NULL,
  published_by integer NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE SET NULL,
  archived_at timestamptz NULL,
  archived_by integer NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE SET NULL,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by integer NOT NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  updated_by integer NOT NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  correlation_id uuid NOT NULL DEFAULT gen_random_uuid(),

  CONSTRAINT quality_control_plan_status_228_ck
    CHECK (status IN ('DRAFT', 'IN_REVIEW', 'PUBLISHED', 'ARCHIVED')),
  CONSTRAINT quality_control_plan_trigger_228_ck
    CHECK (trigger_type IN ('RECEPTION', 'FIRST_ARTICLE', 'IN_PROCESS', 'FINAL', 'LOT_RELEASE', 'PERIODIC', 'RECHECK')),
  CONSTRAINT quality_control_plan_sampling_228_ck
    CHECK (sampling_rule IN ('ALL', 'FIXED', 'PERCENT', 'FIRST_ARTICLE', 'LOT')),
  CONSTRAINT quality_control_plan_sampling_value_228_ck
    CHECK (
      (sampling_rule = 'FIXED' AND sampling_value IS NOT NULL AND sampling_value >= 1)
      OR (sampling_rule = 'PERCENT' AND sampling_value IS NOT NULL AND sampling_value > 0 AND sampling_value <= 100)
      OR (sampling_rule NOT IN ('FIXED', 'PERCENT') AND sampling_value IS NULL)
    ),
  CONSTRAINT quality_control_plan_version_228_ck CHECK (version >= 1),
  CONSTRAINT quality_control_plan_scope_228_ck
    CHECK (
      article_id IS NOT NULL
      OR piece_technique_id IS NOT NULL
      OR piece_version_id IS NOT NULL
      OR famille_id IS NOT NULL
    ),
  CONSTRAINT quality_control_plan_period_228_ck
    CHECK (effective_from IS NULL OR effective_to IS NULL OR effective_from <= effective_to),
  CONSTRAINT quality_control_plan_published_pair_228_ck
    CHECK ((published_at IS NULL) = (published_by IS NULL)),
  CONSTRAINT quality_control_plan_archived_pair_228_ck
    CHECK ((archived_at IS NULL) = (archived_by IS NULL)),
  CONSTRAINT quality_control_plan_published_status_228_ck
    CHECK (published_at IS NOT NULL OR status <> 'PUBLISHED'),
  CONSTRAINT quality_control_plan_code_version_228_uq UNIQUE (code, version)
);

CREATE INDEX IF NOT EXISTS quality_control_plan_status_228_idx
  ON public.quality_control_plan (status, trigger_type);
CREATE INDEX IF NOT EXISTS quality_control_plan_scope_228_idx
  ON public.quality_control_plan (piece_version_id, piece_technique_id, article_id, famille_id);
CREATE INDEX IF NOT EXISTS quality_control_plan_code_228_idx
  ON public.quality_control_plan (code, version DESC);

CREATE TABLE IF NOT EXISTS public.quality_control_plan_characteristic (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id uuid NOT NULL
    REFERENCES public.quality_control_plan(id) ON UPDATE RESTRICT ON DELETE CASCADE,

  characteristic_key text NOT NULL,
  position integer NOT NULL,
  label text NOT NULL,
  characteristic_type text NOT NULL DEFAULT 'DIMENSIONAL',
  value_kind text NOT NULL DEFAULT 'NUMERIC',

  unit text NULL,
  nominal numeric NULL,
  tolerance_min numeric NULL,
  tolerance_max numeric NULL,
  precision_digits integer NULL,
  expected_boolean boolean NULL,
  allowed_values jsonb NULL,

  criticality text NOT NULL DEFAULT 'MAJOR',
  mandatory boolean NOT NULL DEFAULT true,
  requires_instrument boolean NOT NULL DEFAULT false,
  instrument_category text NULL,
  method text NULL,
  acceptance_rule text NULL,

  sampling_rule text NOT NULL DEFAULT 'ALL',
  sampling_value numeric(12, 4) NULL,
  sampling_justification text NULL,
  trigger_type text NOT NULL DEFAULT 'FINAL',

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT quality_plan_char_type_228_ck
    CHECK (characteristic_type IN ('DIMENSIONAL', 'VISUAL', 'DOCUMENTARY', 'MATERIAL', 'FUNCTIONAL', 'OTHER')),
  CONSTRAINT quality_plan_char_value_kind_228_ck
    CHECK (value_kind IN ('NUMERIC', 'BOOLEAN', 'ENUM', 'TEXT')),
  CONSTRAINT quality_plan_char_criticality_228_ck
    CHECK (criticality IN ('CRITICAL', 'MAJOR', 'MINOR')),
  CONSTRAINT quality_plan_char_sampling_228_ck
    CHECK (sampling_rule IN ('ALL', 'FIXED', 'PERCENT', 'FIRST_ARTICLE', 'LOT')),
  CONSTRAINT quality_plan_char_sampling_value_228_ck
    CHECK (
      (sampling_rule = 'FIXED' AND sampling_value IS NOT NULL AND sampling_value >= 1)
      OR (sampling_rule = 'PERCENT' AND sampling_value IS NOT NULL AND sampling_value > 0 AND sampling_value <= 100)
      OR (sampling_rule NOT IN ('FIXED', 'PERCENT') AND sampling_value IS NULL)
    ),
  CONSTRAINT quality_plan_char_trigger_228_ck
    CHECK (trigger_type IN ('RECEPTION', 'FIRST_ARTICLE', 'IN_PROCESS', 'FINAL', 'LOT_RELEASE', 'PERIODIC', 'RECHECK')),
  CONSTRAINT quality_plan_char_position_228_ck CHECK (position >= 1),
  CONSTRAINT quality_plan_char_tolerance_228_ck
    CHECK (tolerance_min IS NULL OR tolerance_max IS NULL OR tolerance_min <= tolerance_max),
  CONSTRAINT quality_plan_char_numeric_unit_228_ck
    CHECK (value_kind <> 'NUMERIC' OR (unit IS NOT NULL AND btrim(unit) <> '')),
  CONSTRAINT quality_plan_char_numeric_bounds_228_ck
    CHECK (value_kind <> 'NUMERIC' OR tolerance_min IS NOT NULL OR tolerance_max IS NOT NULL),
  CONSTRAINT quality_plan_char_boolean_228_ck
    CHECK (value_kind <> 'BOOLEAN' OR expected_boolean IS NOT NULL),
  CONSTRAINT quality_plan_char_enum_228_ck
    CHECK (
      value_kind <> 'ENUM'
      OR (allowed_values IS NOT NULL AND jsonb_typeof(allowed_values) = 'array' AND jsonb_array_length(allowed_values) >= 1)
    ),
  CONSTRAINT quality_plan_char_key_228_uq UNIQUE (plan_id, characteristic_key),
  CONSTRAINT quality_plan_char_position_228_uq UNIQUE (plan_id, position) DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX IF NOT EXISTS quality_plan_char_plan_228_idx
  ON public.quality_control_plan_characteristic (plan_id, position);

/* -------------------------------------------------------------------------- */
/* 3) Exécutions : source typée, snapshot figé, registre de quantités         */
/* -------------------------------------------------------------------------- */

ALTER TABLE public.quality_control
  ADD COLUMN IF NOT EXISTS plan_id uuid NULL,
  ADD COLUMN IF NOT EXISTS plan_version integer NULL,
  ADD COLUMN IF NOT EXISTS plan_snapshot jsonb NULL,
  ADD COLUMN IF NOT EXISTS plan_snapshot_sha256 text NULL,
  ADD COLUMN IF NOT EXISTS source_type text NULL,
  ADD COLUMN IF NOT EXISTS source_id text NULL,
  ADD COLUMN IF NOT EXISTS reception_ligne_id uuid NULL,
  ADD COLUMN IF NOT EXISTS reception_inspection_id uuid NULL,
  ADD COLUMN IF NOT EXISTS lot_id uuid NULL,
  ADD COLUMN IF NOT EXISTS article_id uuid NULL,
  ADD COLUMN IF NOT EXISTS fournisseur_id uuid NULL,
  ADD COLUMN IF NOT EXISTS bon_livraison_id uuid NULL,
  ADD COLUMN IF NOT EXISTS trigger_type text NULL,
  ADD COLUMN IF NOT EXISTS verdict text NULL,
  ADD COLUMN IF NOT EXISTS verdict_computed text NULL,
  ADD COLUMN IF NOT EXISTS verdict_override_reason text NULL,
  ADD COLUMN IF NOT EXISTS verdict_overridden_by integer NULL,
  ADD COLUMN IF NOT EXISTS unite text NULL,
  ADD COLUMN IF NOT EXISTS qty_population numeric(18, 3) NULL,
  ADD COLUMN IF NOT EXISTS qty_controlled numeric(18, 3) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS qty_conforming numeric(18, 3) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS qty_released numeric(18, 3) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS qty_held numeric(18, 3) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS qty_scrapped numeric(18, 3) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS qty_reworked numeric(18, 3) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS qty_sorted numeric(18, 3) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS qty_returned numeric(18, 3) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS qty_consumed numeric(18, 3) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS correlation_id uuid NOT NULL DEFAULT gen_random_uuid();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'quality_control_plan_228_fkey'
      AND conrelid = 'public.quality_control'::regclass
  ) THEN
    ALTER TABLE public.quality_control
      ADD CONSTRAINT quality_control_plan_228_fkey
      FOREIGN KEY (plan_id) REFERENCES public.quality_control_plan(id)
      ON UPDATE RESTRICT ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'quality_control_verdict_228_ck'
      AND conrelid = 'public.quality_control'::regclass
  ) THEN
    ALTER TABLE public.quality_control
      ADD CONSTRAINT quality_control_verdict_228_ck
      CHECK (verdict IS NULL OR verdict IN ('CONFORME', 'NON_CONFORME', 'PARTIEL', 'EN_ATTENTE'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'quality_control_source_type_228_ck'
      AND conrelid = 'public.quality_control'::regclass
  ) THEN
    ALTER TABLE public.quality_control
      ADD CONSTRAINT quality_control_source_type_228_ck
      CHECK (
        source_type IS NULL
        OR source_type IN (
          'RECEPTION_LINE', 'OF', 'OF_OPERATION', 'LOT', 'STOCK_LEVEL',
          'ARTICLE', 'PIECE_TECHNIQUE', 'FOURNISSEUR', 'DELIVERY_LINE'
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'quality_control_source_pair_228_ck'
      AND conrelid = 'public.quality_control'::regclass
  ) THEN
    ALTER TABLE public.quality_control
      ADD CONSTRAINT quality_control_source_pair_228_ck
      CHECK ((source_type IS NULL) = (source_id IS NULL));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'quality_control_snapshot_pair_228_ck'
      AND conrelid = 'public.quality_control'::regclass
  ) THEN
    ALTER TABLE public.quality_control
      ADD CONSTRAINT quality_control_snapshot_pair_228_ck
      CHECK ((plan_snapshot IS NULL) = (plan_snapshot_sha256 IS NULL));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'quality_control_snapshot_hash_228_ck'
      AND conrelid = 'public.quality_control'::regclass
  ) THEN
    ALTER TABLE public.quality_control
      ADD CONSTRAINT quality_control_snapshot_hash_228_ck
      CHECK (plan_snapshot_sha256 IS NULL OR plan_snapshot_sha256 ~ '^[a-f0-9]{64}$');
  END IF;

  -- Registre de quantités : jamais négatif, jamais au-delà de la population,
  -- cumuls cohérents. Ajouté NOT VALID puis validé pour rester non bloquant
  -- sur des données historiques éventuellement partielles.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'quality_control_qty_nonneg_228_ck'
      AND conrelid = 'public.quality_control'::regclass
  ) THEN
    ALTER TABLE public.quality_control
      ADD CONSTRAINT quality_control_qty_nonneg_228_ck
      CHECK (
        qty_controlled >= 0 AND qty_conforming >= 0 AND qty_released >= 0
        AND qty_held >= 0 AND qty_scrapped >= 0 AND qty_reworked >= 0
        AND qty_sorted >= 0 AND qty_returned >= 0 AND qty_consumed >= 0
        AND (qty_population IS NULL OR qty_population > 0)
      ) NOT VALID;
    ALTER TABLE public.quality_control VALIDATE CONSTRAINT quality_control_qty_nonneg_228_ck;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'quality_control_qty_ledger_228_ck'
      AND conrelid = 'public.quality_control'::regclass
  ) THEN
    ALTER TABLE public.quality_control
      ADD CONSTRAINT quality_control_qty_ledger_228_ck
      CHECK (
        qty_population IS NULL
        OR (
          qty_controlled <= qty_population
          AND qty_conforming <= qty_controlled
          AND qty_released <= qty_conforming
          AND qty_consumed <= qty_released
          AND (qty_released + qty_held + qty_scrapped + qty_reworked + qty_sorted + qty_returned) <= qty_population
        )
      ) NOT VALID;
    ALTER TABLE public.quality_control VALIDATE CONSTRAINT quality_control_qty_ledger_228_ck;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS quality_control_plan_228_idx ON public.quality_control (plan_id);
CREATE INDEX IF NOT EXISTS quality_control_source_228_idx ON public.quality_control (source_type, source_id);
CREATE INDEX IF NOT EXISTS quality_control_lot_228_idx ON public.quality_control (lot_id);
CREATE INDEX IF NOT EXISTS quality_control_reception_line_228_idx ON public.quality_control (reception_ligne_id);
CREATE INDEX IF NOT EXISTS quality_control_verdict_228_idx ON public.quality_control (verdict);

/* -------------------------------------------------------------------------- */
/* 4) Mesures : clé de caractéristique, échantillon, instrument               */
/* -------------------------------------------------------------------------- */

ALTER TABLE public.quality_control_points
  ADD COLUMN IF NOT EXISTS characteristic_key text NULL,
  ADD COLUMN IF NOT EXISTS sample_no integer NULL,
  ADD COLUMN IF NOT EXISTS value_boolean boolean NULL,
  ADD COLUMN IF NOT EXISTS value_text text NULL,
  ADD COLUMN IF NOT EXISTS instrument_id uuid NULL,
  ADD COLUMN IF NOT EXISTS instrument_snapshot jsonb NULL,
  ADD COLUMN IF NOT EXISTS evaluation_code text NULL,
  ADD COLUMN IF NOT EXISTS criticality text NULL,
  ADD COLUMN IF NOT EXISTS measured_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS recorded_by integer NULL,
  ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'quality_control_points_sample_228_ck'
      AND conrelid = 'public.quality_control_points'::regclass
  ) THEN
    ALTER TABLE public.quality_control_points
      ADD CONSTRAINT quality_control_points_sample_228_ck
      CHECK (sample_no IS NULL OR sample_no >= 1);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'quality_control_points_criticality_228_ck'
      AND conrelid = 'public.quality_control_points'::regclass
  ) THEN
    ALTER TABLE public.quality_control_points
      ADD CONSTRAINT quality_control_points_criticality_228_ck
      CHECK (criticality IS NULL OR criticality IN ('CRITICAL', 'MAJOR', 'MINOR'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'quality_control_points_revision_228_ck'
      AND conrelid = 'public.quality_control_points'::regclass
  ) THEN
    ALTER TABLE public.quality_control_points
      ADD CONSTRAINT quality_control_points_revision_228_ck CHECK (revision >= 1);
  END IF;

  IF to_regclass('public.metrologie_equipements') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'quality_control_points_instrument_228_fkey'
      AND conrelid = 'public.quality_control_points'::regclass
  ) THEN
    ALTER TABLE public.quality_control_points
      ADD CONSTRAINT quality_control_points_instrument_228_fkey
      FOREIGN KEY (instrument_id) REFERENCES public.metrologie_equipements(id)
      ON UPDATE RESTRICT ON DELETE RESTRICT;
  END IF;
END $$;

-- Un échantillon donné n'existe qu'une fois par caractéristique et exécution.
CREATE UNIQUE INDEX IF NOT EXISTS quality_control_points_sample_228_uq
  ON public.quality_control_points (quality_control_id, characteristic_key, sample_no)
  WHERE characteristic_key IS NOT NULL AND sample_no IS NOT NULL;

CREATE INDEX IF NOT EXISTS quality_control_points_instrument_228_idx
  ON public.quality_control_points (instrument_id);

-- Historique des corrections de mesure : append-only, jamais d'écrasement.
CREATE TABLE IF NOT EXISTS public.quality_measurement_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  point_id uuid NOT NULL
    REFERENCES public.quality_control_points(id) ON UPDATE RESTRICT ON DELETE CASCADE,
  quality_control_id uuid NOT NULL
    REFERENCES public.quality_control(id) ON UPDATE RESTRICT ON DELETE CASCADE,
  revision integer NOT NULL,
  old_values jsonb NULL,
  new_values jsonb NOT NULL,
  reason text NOT NULL,
  actor_user_id integer NOT NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  correlation_id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT quality_measurement_revisions_revision_228_ck CHECK (revision >= 1),
  CONSTRAINT quality_measurement_revisions_reason_228_ck CHECK (char_length(btrim(reason)) >= 5),
  CONSTRAINT quality_measurement_revisions_228_uq UNIQUE (point_id, revision)
);

CREATE INDEX IF NOT EXISTS quality_measurement_revisions_control_228_idx
  ON public.quality_measurement_revisions (quality_control_id, created_at DESC);

/* -------------------------------------------------------------------------- */
/* 5) Décisions de libération                                                 */
/* -------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS public.quality_release_decision (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quality_control_id uuid NOT NULL
    REFERENCES public.quality_control(id) ON UPDATE RESTRICT ON DELETE RESTRICT,

  decision text NOT NULL,
  object_type text NOT NULL,
  object_id text NOT NULL,
  qty numeric(18, 3) NOT NULL,
  unite text NOT NULL,

  verdict text NOT NULL,
  derogation_id uuid NULL,
  justification text NULL,

  decided_by integer NOT NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  decided_at timestamptz NOT NULL DEFAULT now(),
  executed_by integer NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE SET NULL,

  preview_sha256 text NOT NULL,
  idempotency_key text NULL,
  correlation_id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT quality_release_decision_228_ck
    CHECK (decision IN ('FULL', 'PARTIAL', 'HOLD', 'REJECT')),
  CONSTRAINT quality_release_object_228_ck
    CHECK (object_type IN (
      'RECEPTION_LINE', 'OF', 'OF_OPERATION', 'LOT', 'STOCK_LEVEL',
      'ARTICLE', 'PIECE_TECHNIQUE', 'FOURNISSEUR', 'DELIVERY_LINE'
    )),
  CONSTRAINT quality_release_verdict_228_ck
    CHECK (verdict IN ('CONFORME', 'NON_CONFORME', 'PARTIEL', 'EN_ATTENTE')),
  CONSTRAINT quality_release_qty_228_ck CHECK (qty >= 0),
  CONSTRAINT quality_release_preview_228_ck CHECK (preview_sha256 ~ '^[a-f0-9]{64}$')
);

CREATE INDEX IF NOT EXISTS quality_release_decision_control_228_idx
  ON public.quality_release_decision (quality_control_id, decided_at DESC);
CREATE INDEX IF NOT EXISTS quality_release_decision_object_228_idx
  ON public.quality_release_decision (object_type, object_id, decided_at DESC);

/* -------------------------------------------------------------------------- */
/* 6) Dérogations / concessions                                               */
/* -------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS public.quality_derogation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  derogation_type text NOT NULL DEFAULT 'CONCESSION',
  status text NOT NULL DEFAULT 'DRAFT',

  non_conformity_id uuid NULL
    REFERENCES public.non_conformity(id) ON UPDATE RESTRICT ON DELETE SET NULL,
  client_id text NULL,
  fournisseur_id uuid NULL,

  article_id uuid NULL,
  piece_technique_id uuid NULL,
  piece_version_id uuid NULL,
  lot_id uuid NULL,
  of_id bigint NULL,
  commande_id uuid NULL,
  bon_livraison_id uuid NULL,

  requirement text NOT NULL,
  deviation text NOT NULL,
  risk_analysis text NULL,
  conditions text NULL,

  max_qty numeric(18, 3) NULL,
  unite text NULL,
  consumed_qty numeric(18, 3) NOT NULL DEFAULT 0,

  valid_from timestamptz NULL,
  valid_to timestamptz NULL,

  requested_by integer NOT NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  requested_at timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz NULL,
  approved_by integer NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE SET NULL,
  approved_at timestamptz NULL,
  rejected_by integer NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE SET NULL,
  rejected_at timestamptz NULL,
  rejection_reason text NULL,
  revoked_by integer NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE SET NULL,
  revoked_at timestamptz NULL,
  revocation_reason text NULL,
  customer_agreement_reference text NULL,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by integer NOT NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  updated_by integer NOT NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  correlation_id uuid NOT NULL DEFAULT gen_random_uuid(),

  CONSTRAINT quality_derogation_status_228_ck
    CHECK (status IN ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'CONSUMED', 'EXPIRED', 'REVOKED')),
  CONSTRAINT quality_derogation_type_228_ck
    CHECK (derogation_type IN ('CONCESSION', 'DEVIATION_PERMIT', 'SPECIAL_ACCEPTANCE')),
  CONSTRAINT quality_derogation_scope_228_ck
    CHECK (
      article_id IS NOT NULL OR piece_technique_id IS NOT NULL OR piece_version_id IS NOT NULL
      OR lot_id IS NOT NULL OR of_id IS NOT NULL OR commande_id IS NOT NULL
      OR bon_livraison_id IS NOT NULL
    ),
  CONSTRAINT quality_derogation_qty_228_ck
    CHECK (
      consumed_qty >= 0
      AND (max_qty IS NULL OR (max_qty > 0 AND consumed_qty <= max_qty))
      AND (max_qty IS NULL OR (unite IS NOT NULL AND btrim(unite) <> ''))
    ),
  CONSTRAINT quality_derogation_period_228_ck
    CHECK (valid_from IS NULL OR valid_to IS NULL OR valid_from <= valid_to),
  CONSTRAINT quality_derogation_approval_pair_228_ck
    CHECK ((approved_at IS NULL) = (approved_by IS NULL)),
  CONSTRAINT quality_derogation_rejection_pair_228_ck
    CHECK ((rejected_at IS NULL) = (rejected_by IS NULL)),
  CONSTRAINT quality_derogation_revocation_pair_228_ck
    CHECK ((revoked_at IS NULL) = (revoked_by IS NULL)),
  CONSTRAINT quality_derogation_approved_state_228_ck
    CHECK (status NOT IN ('APPROVED', 'CONSUMED') OR approved_at IS NOT NULL),
  -- Séparation des tâches gravée en base : le demandeur n'approuve pas.
  CONSTRAINT quality_derogation_separation_228_ck
    CHECK (approved_by IS NULL OR approved_by <> requested_by),
  CONSTRAINT quality_derogation_requirement_228_ck
    CHECK (char_length(btrim(requirement)) >= 3 AND char_length(btrim(deviation)) >= 3)
);

CREATE INDEX IF NOT EXISTS quality_derogation_status_228_idx
  ON public.quality_derogation (status, valid_to);
CREATE INDEX IF NOT EXISTS quality_derogation_nc_228_idx
  ON public.quality_derogation (non_conformity_id);
CREATE INDEX IF NOT EXISTS quality_derogation_scope_228_idx
  ON public.quality_derogation (lot_id, piece_version_id, article_id);

CREATE TABLE IF NOT EXISTS public.quality_derogation_consumption (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  derogation_id uuid NOT NULL
    REFERENCES public.quality_derogation(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  quality_control_id uuid NULL
    REFERENCES public.quality_control(id) ON UPDATE RESTRICT ON DELETE SET NULL,
  release_decision_id uuid NULL
    REFERENCES public.quality_release_decision(id) ON UPDATE RESTRICT ON DELETE SET NULL,
  bon_livraison_id uuid NULL,

  qty numeric(18, 3) NOT NULL,
  unite text NOT NULL,
  context jsonb NOT NULL DEFAULT '{}'::jsonb,

  actor_user_id integer NOT NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  idempotency_key text NULL,
  correlation_id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT quality_derogation_consumption_qty_228_ck CHECK (qty > 0),
  CONSTRAINT quality_derogation_consumption_context_228_ck
    CHECK (jsonb_typeof(context) = 'object'),
  -- Une même décision de libération ne consomme pas deux fois la concession.
  CONSTRAINT quality_derogation_consumption_release_228_uq UNIQUE (derogation_id, release_decision_id)
);

CREATE INDEX IF NOT EXISTS quality_derogation_consumption_derogation_228_idx
  ON public.quality_derogation_consumption (derogation_id, created_at DESC);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'quality_release_derogation_228_fkey'
      AND conrelid = 'public.quality_release_decision'::regclass
  ) THEN
    ALTER TABLE public.quality_release_decision
      ADD CONSTRAINT quality_release_derogation_228_fkey
      FOREIGN KEY (derogation_id) REFERENCES public.quality_derogation(id)
      ON UPDATE RESTRICT ON DELETE RESTRICT;
  END IF;
END $$;

/* -------------------------------------------------------------------------- */
/* 7) Non-conformités : origine, quantité, 5 Why / 8D, CAPA                   */
/* -------------------------------------------------------------------------- */

ALTER TABLE public.non_conformity
  ADD COLUMN IF NOT EXISTS origin text NULL,
  ADD COLUMN IF NOT EXISTS defect_category text NULL,
  ADD COLUMN IF NOT EXISTS qty numeric(18, 3) NULL,
  ADD COLUMN IF NOT EXISTS unite text NULL,
  ADD COLUMN IF NOT EXISTS owner_user_id integer NULL,
  ADD COLUMN IF NOT EXISTS confidentiality text NOT NULL DEFAULT 'INTERNAL',
  ADD COLUMN IF NOT EXISTS capa_required boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS effectiveness_verified_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS effectiveness_verified_by integer NULL,
  ADD COLUMN IF NOT EXISTS reopened_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS reopened_by integer NULL,
  ADD COLUMN IF NOT EXISTS reopen_reason text NULL,
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS cancelled_by integer NULL,
  ADD COLUMN IF NOT EXISTS cancellation_reason text NULL,
  ADD COLUMN IF NOT EXISTS correlation_id uuid NOT NULL DEFAULT gen_random_uuid();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'non_conformity_origin_228_ck'
      AND conrelid = 'public.non_conformity'::regclass
  ) THEN
    ALTER TABLE public.non_conformity
      ADD CONSTRAINT non_conformity_origin_228_ck
      CHECK (
        origin IS NULL
        OR origin IN (
          'CONTROL', 'RECEPTION', 'PRODUCTION', 'OPERATION', 'STOCK',
          'DELIVERY', 'CUSTOMER_CLAIM', 'SUPPLIER', 'AUDIT', 'OTHER'
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'non_conformity_confidentiality_228_ck'
      AND conrelid = 'public.non_conformity'::regclass
  ) THEN
    ALTER TABLE public.non_conformity
      ADD CONSTRAINT non_conformity_confidentiality_228_ck
      CHECK (confidentiality IN ('INTERNAL', 'RESTRICTED', 'CUSTOMER_VISIBLE'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'non_conformity_qty_228_ck'
      AND conrelid = 'public.non_conformity'::regclass
  ) THEN
    ALTER TABLE public.non_conformity
      ADD CONSTRAINT non_conformity_qty_228_ck
      CHECK (qty IS NULL OR (qty > 0 AND unite IS NOT NULL AND btrim(unite) <> ''));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'non_conformity_owner_228_fkey'
      AND conrelid = 'public.non_conformity'::regclass
  ) THEN
    ALTER TABLE public.non_conformity
      ADD CONSTRAINT non_conformity_owner_228_fkey
      FOREIGN KEY (owner_user_id) REFERENCES public.users(id)
      ON UPDATE RESTRICT ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS non_conformity_origin_228_idx ON public.non_conformity (origin);
CREATE INDEX IF NOT EXISTS non_conformity_owner_228_idx ON public.non_conformity (owner_user_id);

-- Résolution guidée 5 Why / 8D : une ligne par étape, bornée et gouvernée.
CREATE TABLE IF NOT EXISTS public.non_conformity_analysis (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  non_conformity_id uuid NOT NULL
    REFERENCES public.non_conformity(id) ON UPDATE RESTRICT ON DELETE CASCADE,
  method text NOT NULL,
  step_code text NOT NULL,
  position integer NOT NULL,
  question text NULL,
  answer text NULL,
  owner_user_id integer NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE SET NULL,
  due_date date NULL,
  completed_at timestamptz NULL,
  completed_by integer NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE SET NULL,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by integer NOT NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  updated_by integer NOT NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,

  CONSTRAINT non_conformity_analysis_method_228_ck CHECK (method IN ('FIVE_WHY', 'EIGHT_D')),
  CONSTRAINT non_conformity_analysis_position_228_ck CHECK (position BETWEEN 1 AND 20),
  CONSTRAINT non_conformity_analysis_answer_228_ck
    CHECK (answer IS NULL OR char_length(answer) <= 4000),
  CONSTRAINT non_conformity_analysis_question_228_ck
    CHECK (question IS NULL OR char_length(question) <= 1000),
  CONSTRAINT non_conformity_analysis_completed_pair_228_ck
    CHECK ((completed_at IS NULL) = (completed_by IS NULL)),
  CONSTRAINT non_conformity_analysis_step_228_uq UNIQUE (non_conformity_id, method, step_code)
);

CREATE INDEX IF NOT EXISTS non_conformity_analysis_nc_228_idx
  ON public.non_conformity_analysis (non_conformity_id, method, position);

ALTER TABLE public.quality_action
  ADD COLUMN IF NOT EXISTS priority text NOT NULL DEFAULT 'NORMAL',
  ADD COLUMN IF NOT EXISTS mandatory boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS started_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS completed_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS evidence_required boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS analysis_id uuid NULL,
  ADD COLUMN IF NOT EXISTS correlation_id uuid NOT NULL DEFAULT gen_random_uuid();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'quality_action_priority_228_ck'
      AND conrelid = 'public.quality_action'::regclass
  ) THEN
    ALTER TABLE public.quality_action
      ADD CONSTRAINT quality_action_priority_228_ck
      CHECK (priority IN ('LOW', 'NORMAL', 'HIGH', 'CRITICAL'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'quality_action_analysis_228_fkey'
      AND conrelid = 'public.quality_action'::regclass
  ) THEN
    ALTER TABLE public.quality_action
      ADD CONSTRAINT quality_action_analysis_228_fkey
      FOREIGN KEY (analysis_id) REFERENCES public.non_conformity_analysis(id)
      ON UPDATE RESTRICT ON DELETE SET NULL;
  END IF;
END $$;

-- Reprise de contrôle ajoutée à la liste des dispositions existantes.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'non_conformity_dispositions_type_check'
      AND conrelid = 'public.non_conformity_dispositions'::regclass
  ) THEN
    ALTER TABLE public.non_conformity_dispositions
      DROP CONSTRAINT non_conformity_dispositions_type_check;
  END IF;

  ALTER TABLE public.non_conformity_dispositions
    ADD CONSTRAINT non_conformity_dispositions_type_check
    CHECK (disposition_type IN (
      'HOLD', 'RELEASE', 'USE_AS_IS', 'REWORK', 'SORT', 'SCRAP', 'RETURN_SUPPLIER', 'RECHECK'
    )) NOT VALID;
  ALTER TABLE public.non_conformity_dispositions
    VALIDATE CONSTRAINT non_conformity_dispositions_type_check;
END $$;

ALTER TABLE public.non_conformity_dispositions
  ADD COLUMN IF NOT EXISTS derogation_id uuid NULL,
  ADD COLUMN IF NOT EXISTS quality_control_id uuid NULL,
  ADD COLUMN IF NOT EXISTS instructions text NULL,
  ADD COLUMN IF NOT EXISTS idempotency_key text NULL,
  ADD COLUMN IF NOT EXISTS preview_sha256 text NULL,
  ADD COLUMN IF NOT EXISTS correlation_id uuid NOT NULL DEFAULT gen_random_uuid();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'non_conformity_dispositions_derogation_228_fkey'
      AND conrelid = 'public.non_conformity_dispositions'::regclass
  ) THEN
    ALTER TABLE public.non_conformity_dispositions
      ADD CONSTRAINT non_conformity_dispositions_derogation_228_fkey
      FOREIGN KEY (derogation_id) REFERENCES public.quality_derogation(id)
      ON UPDATE RESTRICT ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'non_conformity_dispositions_control_228_fkey'
      AND conrelid = 'public.non_conformity_dispositions'::regclass
  ) THEN
    ALTER TABLE public.non_conformity_dispositions
      ADD CONSTRAINT non_conformity_dispositions_control_228_fkey
      FOREIGN KEY (quality_control_id) REFERENCES public.quality_control(id)
      ON UPDATE RESTRICT ON DELETE SET NULL;
  END IF;
END $$;

-- Une clé d'idempotence ne produit qu'une disposition.
CREATE UNIQUE INDEX IF NOT EXISTS non_conformity_dispositions_idem_228_uq
  ON public.non_conformity_dispositions (non_conformity_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

/* -------------------------------------------------------------------------- */
/* 8) Documents, idempotence et journal                                       */
/* -------------------------------------------------------------------------- */

ALTER TABLE public.quality_documents
  ADD COLUMN IF NOT EXISTS revision text NULL,
  ADD COLUMN IF NOT EXISTS confidentiality text NOT NULL DEFAULT 'INTERNAL',
  ADD COLUMN IF NOT EXISTS retention_until date NULL,
  ADD COLUMN IF NOT EXISTS decision_evidence boolean NOT NULL DEFAULT false;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'quality_documents_confidentiality_228_ck'
      AND conrelid = 'public.quality_documents'::regclass
  ) THEN
    ALTER TABLE public.quality_documents
      ADD CONSTRAINT quality_documents_confidentiality_228_ck
      CHECK (confidentiality IN ('INTERNAL', 'RESTRICTED', 'CUSTOMER_VISIBLE'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.quality_command_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id integer NOT NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  command_type text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  request_payload jsonb NOT NULL,
  result_payload jsonb NOT NULL,
  correlation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT quality_command_receipts_actor_key_228_uq UNIQUE (actor_user_id, idempotency_key),
  CONSTRAINT quality_command_receipts_key_228_ck
    CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
  CONSTRAINT quality_command_receipts_hash_228_ck CHECK (request_hash ~ '^[A-Fa-f0-9]{64}$'),
  CONSTRAINT quality_command_receipts_type_228_ck
    CHECK (char_length(command_type) BETWEEN 3 AND 120),
  CONSTRAINT quality_command_receipts_aggregate_228_ck
    CHECK (aggregate_type IN ('PLAN', 'CONTROL', 'NON_CONFORMITY', 'ACTION', 'DEROGATION', 'RELEASE', 'DISPOSITION'))
);

CREATE INDEX IF NOT EXISTS quality_command_receipts_resource_228_idx
  ON public.quality_command_receipts (aggregate_type, aggregate_id, created_at DESC);

ALTER TABLE public.quality_event_log
  ADD COLUMN IF NOT EXISTS correlation_id uuid NULL,
  ADD COLUMN IF NOT EXISTS idempotency_key text NULL,
  ADD COLUMN IF NOT EXISTS rule_code text NULL,
  ADD COLUMN IF NOT EXISTS reason text NULL,
  ADD COLUMN IF NOT EXISTS request_id text NULL,
  ADD COLUMN IF NOT EXISTS source text NULL;

CREATE INDEX IF NOT EXISTS quality_event_log_correlation_228_idx
  ON public.quality_event_log (correlation_id);

/* -------------------------------------------------------------------------- */
/* 9) Immuabilité et append-only                                              */
/* -------------------------------------------------------------------------- */

-- Un plan publié ou archivé est figé : seul le passage de statut piloté par
-- l'API (avec ses horodatages) reste autorisé.
CREATE OR REPLACE FUNCTION public.fn_protect_quality_plan_228()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status IN ('PUBLISHED', 'ARCHIVED') THEN
      RAISE EXCEPTION 'a published quality control plan is immutable and cannot be deleted';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status IN ('PUBLISHED', 'ARCHIVED') THEN
    IF NEW.code <> OLD.code
      OR NEW.version <> OLD.version
      OR NEW.label <> OLD.label
      OR NEW.trigger_type <> OLD.trigger_type
      OR COALESCE(NEW.article_id::text, '') <> COALESCE(OLD.article_id::text, '')
      OR COALESCE(NEW.piece_technique_id::text, '') <> COALESCE(OLD.piece_technique_id::text, '')
      OR COALESCE(NEW.piece_version_id::text, '') <> COALESCE(OLD.piece_version_id::text, '')
      OR COALESCE(NEW.famille_id::text, '') <> COALESCE(OLD.famille_id::text, '')
      OR COALESCE(NEW.operation_code, '') <> COALESCE(OLD.operation_code, '')
      OR COALESCE(NEW.fournisseur_id::text, '') <> COALESCE(OLD.fournisseur_id::text, '')
      OR NEW.sampling_rule <> OLD.sampling_rule
      OR COALESCE(NEW.sampling_value, -1) <> COALESCE(OLD.sampling_value, -1)
      OR COALESCE(NEW.effective_from::text, '') <> COALESCE(OLD.effective_from::text, '')
      OR COALESCE(NEW.published_at::text, '') <> COALESCE(OLD.published_at::text, '')
    THEN
      RAISE EXCEPTION 'a published quality control plan is immutable: create a new version';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_quality_plan_228 ON public.quality_control_plan;
CREATE TRIGGER trg_protect_quality_plan_228
  BEFORE UPDATE OR DELETE ON public.quality_control_plan
  FOR EACH ROW EXECUTE FUNCTION public.fn_protect_quality_plan_228();

CREATE OR REPLACE FUNCTION public.fn_protect_quality_plan_characteristic_228()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_status text;
  v_plan uuid;
BEGIN
  v_plan := COALESCE(NEW.plan_id, OLD.plan_id);
  SELECT status INTO v_status FROM public.quality_control_plan WHERE id = v_plan;
  IF v_status IN ('PUBLISHED', 'ARCHIVED') THEN
    RAISE EXCEPTION 'characteristics of a published quality control plan are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_quality_plan_char_228 ON public.quality_control_plan_characteristic;
CREATE TRIGGER trg_protect_quality_plan_char_228
  BEFORE INSERT OR UPDATE OR DELETE ON public.quality_control_plan_characteristic
  FOR EACH ROW EXECUTE FUNCTION public.fn_protect_quality_plan_characteristic_228();

-- Le snapshot appliqué et son empreinte ne se réécrivent jamais après coup.
CREATE OR REPLACE FUNCTION public.fn_protect_quality_snapshot_228()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.plan_snapshot_sha256 IS NOT NULL
    AND (
      COALESCE(NEW.plan_snapshot_sha256, '') <> OLD.plan_snapshot_sha256
      OR NEW.plan_snapshot::text <> OLD.plan_snapshot::text
      OR COALESCE(NEW.plan_id::text, '') <> COALESCE(OLD.plan_id::text, '')
      OR COALESCE(NEW.plan_version, -1) <> COALESCE(OLD.plan_version, -1)
    )
  THEN
    RAISE EXCEPTION 'the applied quality plan snapshot is immutable';
  END IF;

  IF OLD.validation_date IS NOT NULL
    AND (
      COALESCE(NEW.qty_population, -1) <> COALESCE(OLD.qty_population, -1)
      OR COALESCE(NEW.unite, '') <> COALESCE(OLD.unite, '')
      OR COALESCE(NEW.source_type, '') <> COALESCE(OLD.source_type, '')
      OR COALESCE(NEW.source_id, '') <> COALESCE(OLD.source_id, '')
    )
  THEN
    RAISE EXCEPTION 'a validated quality control keeps its population, unit and source';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_quality_snapshot_228 ON public.quality_control;
CREATE TRIGGER trg_protect_quality_snapshot_228
  BEFORE UPDATE ON public.quality_control
  FOR EACH ROW EXECUTE FUNCTION public.fn_protect_quality_snapshot_228();

-- Une mesure d'un contrôle déjà validé ne s'écrase pas : elle se corrige par
-- révision auditée (quality_measurement_revisions).
CREATE OR REPLACE FUNCTION public.fn_protect_quality_measurement_228()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_validated timestamptz;
BEGIN
  SELECT validation_date INTO v_validated
  FROM public.quality_control
  WHERE id = COALESCE(NEW.quality_control_id, OLD.quality_control_id);

  IF v_validated IS NOT NULL THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'measurements of a validated quality control cannot be deleted';
    END IF;
    IF TG_OP = 'UPDATE' AND NEW.revision <= OLD.revision THEN
      RAISE EXCEPTION 'a measurement of a validated quality control requires an audited revision';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_quality_measurement_228 ON public.quality_control_points;
CREATE TRIGGER trg_protect_quality_measurement_228
  BEFORE UPDATE OR DELETE ON public.quality_control_points
  FOR EACH ROW EXECUTE FUNCTION public.fn_protect_quality_measurement_228();

-- Append-only générique : preuves, décisions et journal.
CREATE OR REPLACE FUNCTION public.fn_quality_append_only_228()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'quality audit evidence is immutable (append-only): %', TG_TABLE_NAME;
END;
$$;

DROP TRIGGER IF EXISTS trg_quality_event_log_append_only_228 ON public.quality_event_log;
CREATE TRIGGER trg_quality_event_log_append_only_228
  BEFORE UPDATE OR DELETE ON public.quality_event_log
  FOR EACH ROW EXECUTE FUNCTION public.fn_quality_append_only_228();

DROP TRIGGER IF EXISTS trg_quality_measurement_revisions_append_only_228 ON public.quality_measurement_revisions;
CREATE TRIGGER trg_quality_measurement_revisions_append_only_228
  BEFORE UPDATE OR DELETE ON public.quality_measurement_revisions
  FOR EACH ROW EXECUTE FUNCTION public.fn_quality_append_only_228();

DROP TRIGGER IF EXISTS trg_quality_release_decision_append_only_228 ON public.quality_release_decision;
CREATE TRIGGER trg_quality_release_decision_append_only_228
  BEFORE UPDATE OR DELETE ON public.quality_release_decision
  FOR EACH ROW EXECUTE FUNCTION public.fn_quality_append_only_228();

DROP TRIGGER IF EXISTS trg_quality_derogation_consumption_append_only_228 ON public.quality_derogation_consumption;
CREATE TRIGGER trg_quality_derogation_consumption_append_only_228
  BEFORE UPDATE OR DELETE ON public.quality_derogation_consumption
  FOR EACH ROW EXECUTE FUNCTION public.fn_quality_append_only_228();

DROP TRIGGER IF EXISTS trg_quality_command_receipts_append_only_228 ON public.quality_command_receipts;
CREATE TRIGGER trg_quality_command_receipts_append_only_228
  BEFORE UPDATE OR DELETE ON public.quality_command_receipts
  FOR EACH ROW EXECUTE FUNCTION public.fn_quality_append_only_228();

-- Une dérogation approuvée garde son périmètre, son écart et ses plafonds.
CREATE OR REPLACE FUNCTION public.fn_protect_quality_derogation_228()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'only a draft derogation can be deleted';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status IN ('APPROVED', 'CONSUMED', 'REJECTED', 'EXPIRED', 'REVOKED') THEN
    IF NEW.code <> OLD.code
      OR NEW.derogation_type <> OLD.derogation_type
      OR NEW.requirement <> OLD.requirement
      OR NEW.deviation <> OLD.deviation
      OR COALESCE(NEW.max_qty, -1) <> COALESCE(OLD.max_qty, -1)
      OR COALESCE(NEW.unite, '') <> COALESCE(OLD.unite, '')
      OR COALESCE(NEW.valid_from::text, '') <> COALESCE(OLD.valid_from::text, '')
      OR COALESCE(NEW.valid_to::text, '') <> COALESCE(OLD.valid_to::text, '')
      OR COALESCE(NEW.lot_id::text, '') <> COALESCE(OLD.lot_id::text, '')
      OR COALESCE(NEW.piece_version_id::text, '') <> COALESCE(OLD.piece_version_id::text, '')
      OR COALESCE(NEW.article_id::text, '') <> COALESCE(OLD.article_id::text, '')
      OR NEW.requested_by <> OLD.requested_by
    THEN
      RAISE EXCEPTION 'an approved or closed derogation is immutable: request a new one';
    END IF;
  END IF;

  IF NEW.consumed_qty < OLD.consumed_qty THEN
    RAISE EXCEPTION 'derogation consumption cannot decrease';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_quality_derogation_228 ON public.quality_derogation;
CREATE TRIGGER trg_protect_quality_derogation_228
  BEFORE UPDATE OR DELETE ON public.quality_derogation
  FOR EACH ROW EXECUTE FUNCTION public.fn_protect_quality_derogation_228();

-- Les consommations ne peuvent pas dépasser le plafond de la concession.
CREATE OR REPLACE FUNCTION public.fn_check_quality_derogation_cap_228()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_max numeric(18, 3);
  v_status text;
  v_total numeric(18, 3);
BEGIN
  SELECT max_qty, status INTO v_max, v_status
  FROM public.quality_derogation
  WHERE id = NEW.derogation_id
  FOR UPDATE;

  IF v_status IS NULL THEN
    RAISE EXCEPTION 'unknown derogation';
  END IF;
  IF v_status NOT IN ('APPROVED', 'CONSUMED') THEN
    RAISE EXCEPTION 'a derogation must be approved before being consumed (status %)', v_status;
  END IF;

  SELECT COALESCE(SUM(qty), 0) INTO v_total
  FROM public.quality_derogation_consumption
  WHERE derogation_id = NEW.derogation_id;

  IF v_max IS NOT NULL AND v_total > v_max THEN
    RAISE EXCEPTION 'derogation consumptions exceed the approved maximum quantity';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_check_quality_derogation_cap_228 ON public.quality_derogation_consumption;
CREATE TRIGGER trg_check_quality_derogation_cap_228
  AFTER INSERT ON public.quality_derogation_consumption
  FOR EACH ROW EXECUTE FUNCTION public.fn_check_quality_derogation_cap_228();

-- Les documents qualité se suppriment logiquement ; une preuve de décision
-- approuvée n'est jamais effacée.
CREATE OR REPLACE FUNCTION public.fn_protect_quality_documents_228()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'quality documents are removed logically (removed_at), never deleted';
  END IF;
  IF OLD.decision_evidence AND NEW.removed_at IS NOT NULL AND OLD.removed_at IS NULL THEN
    RAISE EXCEPTION 'a decision evidence document cannot be removed';
  END IF;
  IF NEW.sha256 IS DISTINCT FROM OLD.sha256 OR NEW.storage_path <> OLD.storage_path THEN
    RAISE EXCEPTION 'quality document identity (hash, storage) is immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_quality_documents_228 ON public.quality_documents;
CREATE TRIGGER trg_protect_quality_documents_228
  BEFORE UPDATE OR DELETE ON public.quality_documents
  FOR EACH ROW EXECUTE FUNCTION public.fn_protect_quality_documents_228();

/* -------------------------------------------------------------------------- */
/* 10) updated_at triggers                                                    */
/* -------------------------------------------------------------------------- */

DO $$
BEGIN
  IF to_regprocedure('public.tg_set_updated_at()') IS NULL THEN
    RAISE NOTICE 'tg_set_updated_at() not found; skipping #228 updated_at triggers.';
    RETURN;
  END IF;

  EXECUTE 'DROP TRIGGER IF EXISTS quality_control_plan_set_updated_at ON public.quality_control_plan';
  EXECUTE 'CREATE TRIGGER quality_control_plan_set_updated_at BEFORE UPDATE ON public.quality_control_plan FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at()';

  EXECUTE 'DROP TRIGGER IF EXISTS quality_plan_char_set_updated_at ON public.quality_control_plan_characteristic';
  EXECUTE 'CREATE TRIGGER quality_plan_char_set_updated_at BEFORE UPDATE ON public.quality_control_plan_characteristic FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at()';

  EXECUTE 'DROP TRIGGER IF EXISTS quality_derogation_set_updated_at ON public.quality_derogation';
  EXECUTE 'CREATE TRIGGER quality_derogation_set_updated_at BEFORE UPDATE ON public.quality_derogation FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at()';

  EXECUTE 'DROP TRIGGER IF EXISTS non_conformity_analysis_set_updated_at ON public.non_conformity_analysis';
  EXECUTE 'CREATE TRIGGER non_conformity_analysis_set_updated_at BEFORE UPDATE ON public.non_conformity_analysis FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at()';
END $$;

/* -------------------------------------------------------------------------- */
/* 11) Commentaires                                                           */
/* -------------------------------------------------------------------------- */

COMMENT ON TABLE public.quality_control_plan IS
  '#228 Plans de contrôle versionnés : périmètre, déclencheur, échantillonnage, cycle DRAFT/IN_REVIEW/PUBLISHED/ARCHIVED. Un plan publié est immuable.';
COMMENT ON TABLE public.quality_control_plan_characteristic IS
  '#228 Caractéristiques ordonnées et stables d''un plan de contrôle.';
COMMENT ON TABLE public.quality_measurement_revisions IS
  '#228 Historique append-only des corrections de mesure (avant/après, motif, acteur).';
COMMENT ON TABLE public.quality_release_decision IS
  '#228 Décisions de libération/quarantaine sur objet et quantité exacts, append-only.';
COMMENT ON TABLE public.quality_derogation IS
  '#228 Registre des dérogations/concessions : périmètre, écart, risque, plafond, validité, approbations.';
COMMENT ON TABLE public.quality_derogation_consumption IS
  '#228 Consommations immuables d''une concession, liées au contrôle/libération/BL.';
COMMENT ON TABLE public.non_conformity_analysis IS
  '#228 Résolution guidée 5 Why / 8D attachée à une non-conformité.';
COMMENT ON TABLE public.quality_command_receipts IS
  '#228 Reçus d''idempotence des commandes qualité (acteur + Idempotency-Key).';
COMMENT ON COLUMN public.quality_control.plan_snapshot IS
  '#228 Contenu canonique du plan réellement appliqué. Le verdict historique ne se recalcule jamais depuis le plan courant.';
COMMENT ON COLUMN public.quality_control.plan_snapshot_sha256 IS
  '#228 Empreinte SHA-256 du snapshot : toute divergence est une alerte d''intégrité.';

COMMIT;
