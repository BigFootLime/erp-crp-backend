-- SOL-13 - Perspectives de marge et contrat de preuve v2.
-- Métadonnées uniquement : aucune valeur de coût existante n'est modifiée.

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $preflight$
BEGIN
  IF to_regclass('public.margin_input_versions') IS NULL
     OR to_regclass('public.margin_rates') IS NULL
     OR to_regclass('public.margin_recalculations') IS NULL THEN
    RAISE EXCEPTION 'SOL-13: base margin migration 20260805_margin_engine_0001 is missing';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'margin_input_versions'
      AND column_name = 'evidence_contract_version'
  ) THEN
    RAISE EXCEPTION 'SOL-13: target evidence columns already exist without this ledger entry';
  END IF;
END
$preflight$;

ALTER TABLE public.margin_rates
  DROP CONSTRAINT margin_rates_category_ck,
  ADD CONSTRAINT margin_rates_category_ck CHECK (category IN (
    'MATERIAL','PURCHASE','SUBCONTRACTING','MACHINE','OPERATOR','CONTROL',
    'TOOLING','PACKAGING','TRANSPORT','SCRAP','REWORK','OVERHEAD'
  ));

ALTER TABLE public.margin_rate_versions
  ADD COLUMN evidence_contract_version smallint NOT NULL DEFAULT 1,
  ADD COLUMN source_reliability text NOT NULL DEFAULT 'DECLARED',
  ADD CONSTRAINT margin_rate_versions_evidence_version_ck CHECK (evidence_contract_version IN (1, 2)),
  ADD CONSTRAINT margin_rate_versions_source_reliability_ck CHECK (
    source_reliability IN ('ESTIMATED','DECLARED','VERIFIED')
  );

ALTER TABLE public.margin_rate_versions ALTER COLUMN evidence_contract_version SET DEFAULT 2;

ALTER TABLE public.margin_input_versions
  DROP CONSTRAINT margin_input_versions_basis_ck,
  DROP CONSTRAINT margin_input_versions_category_ck,
  ADD COLUMN evidence_contract_version smallint NOT NULL DEFAULT 1,
  ADD COLUMN definition text NULL,
  ADD COLUMN unit text NULL,
  ADD COLUMN period_start date NULL,
  ADD COLUMN period_end date NULL,
  ADD COLUMN source_reliability text NULL,
  ADD COLUMN source_document_type text NULL,
  ADD COLUMN source_document_ref text NULL,
  ADD CONSTRAINT margin_input_versions_basis_ck CHECK (basis IN (
    'PLANNED','QUOTED','STANDARD','UPDATED','ACTUAL'
  )),
  ADD CONSTRAINT margin_input_versions_category_ck CHECK (category IS NULL OR category IN (
    'MATERIAL','PURCHASE','SUBCONTRACTING','MACHINE','OPERATOR','CONTROL',
    'TOOLING','PACKAGING','TRANSPORT','SCRAP','REWORK','OVERHEAD'
  )),
  ADD CONSTRAINT margin_input_versions_evidence_version_ck CHECK (evidence_contract_version IN (1, 2)),
  ADD CONSTRAINT margin_input_versions_evidence_v2_ck CHECK (
    evidence_contract_version = 1 OR (
      definition IS NOT NULL AND btrim(definition) <> ''
      AND unit IS NOT NULL AND btrim(unit) <> ''
      AND period_start IS NOT NULL AND period_end IS NOT NULL AND period_end >= period_start
      AND source_reliability IN ('ESTIMATED','DECLARED','VERIFIED')
      AND (source_reliability <> 'VERIFIED' OR (
        observed_at IS NOT NULL
        AND source_document_type IS NOT NULL AND btrim(source_document_type) <> ''
        AND source_document_ref IS NOT NULL AND btrim(source_document_ref) <> ''
      ))
    )
  );

ALTER TABLE public.margin_input_versions ALTER COLUMN evidence_contract_version SET DEFAULT 2;

ALTER TABLE public.margin_recalculations
  DROP CONSTRAINT margin_recalculations_basis_ck,
  ADD CONSTRAINT margin_recalculations_basis_ck CHECK (basis IN (
    'PLANNED','QUOTED','STANDARD','UPDATED','ACTUAL'
  ));

COMMENT ON COLUMN public.margin_input_versions.evidence_contract_version IS
  'v1 = preuve historique antérieure à SOL-13; v2 = définition, unité, période et fiabilité obligatoires.';
COMMENT ON COLUMN public.margin_input_versions.source_reliability IS
  'ESTIMATED, DECLARED ou VERIFIED. UNKNOWN est rendu uniquement pour les preuves historiques v1.';
COMMENT ON COLUMN public.margin_rate_versions.source_reliability IS
  'Niveau de preuve du référentiel de taux, explicite et conservé avec sa période d effet.';

COMMIT;
