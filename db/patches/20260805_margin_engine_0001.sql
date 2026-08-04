-- CERP FEAT-0001 - Moteur de marge auditable.
-- Append-only: les hypotheses historiques ne sont jamais reecrites.

BEGIN;

CREATE TABLE IF NOT EXISTS public.margin_rate_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  currency char(3) NOT NULL DEFAULT 'EUR' CHECK (currency = 'EUR'),
  effective_from date NOT NULL,
  effective_to date NULL,
  source text NOT NULL CHECK (btrim(source) <> ''),
  assumption_date date NOT NULL,
  notes text NULL,
  supersedes_id uuid NULL REFERENCES public.margin_rate_versions(id) ON DELETE RESTRICT,
  created_by integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT margin_rate_versions_dates_ck CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT margin_rate_versions_code_version_uk UNIQUE (code, version),
  CONSTRAINT margin_rate_versions_no_self_ck CHECK (supersedes_id IS NULL OR supersedes_id <> id)
);

CREATE UNIQUE INDEX IF NOT EXISTS margin_rate_versions_supersedes_uk
  ON public.margin_rate_versions(supersedes_id) WHERE supersedes_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS margin_rate_versions_effective_idx
  ON public.margin_rate_versions(code, effective_from DESC, effective_to);

CREATE TABLE IF NOT EXISTS public.margin_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rate_version_id uuid NOT NULL REFERENCES public.margin_rate_versions(id) ON DELETE RESTRICT,
  rate_code text NOT NULL CHECK (btrim(rate_code) <> ''),
  category text NOT NULL CHECK (category IN (
    'MATERIAL','PURCHASE','SUBCONTRACTING','MACHINE','OPERATOR','CONTROL',
    'TOOLING','PACKAGING','TRANSPORT','SCRAP','OVERHEAD'
  )),
  scope_type text NOT NULL DEFAULT 'GLOBAL' CHECK (scope_type IN (
    'GLOBAL','USER','MACHINE','COST_CENTER','PIECE_TECHNIQUE'
  )),
  scope_ref text NULL,
  amount numeric(18,6) NOT NULL CHECK (amount >= 0),
  unit text NOT NULL CHECK (unit IN ('EUR_PER_HOUR','EUR_PER_UNIT','PERCENT_OF_DIRECT_COST')),
  source_ref text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT margin_rates_scope_ck CHECK (
    (scope_type = 'GLOBAL' AND scope_ref IS NULL) OR
    (scope_type <> 'GLOBAL' AND scope_ref IS NOT NULL AND btrim(scope_ref) <> '')
  ),
  CONSTRAINT margin_rates_version_code_scope_uk UNIQUE (rate_version_id, rate_code, scope_type, scope_ref)
);

CREATE INDEX IF NOT EXISTS margin_rates_resolution_idx
  ON public.margin_rates(category, scope_type, scope_ref, rate_version_id);
CREATE UNIQUE INDEX IF NOT EXISTS margin_rates_version_code_scope_coalesced_uk
  ON public.margin_rates(rate_version_id, rate_code, scope_type, COALESCE(scope_ref, ''));

CREATE TABLE IF NOT EXISTS public.margin_input_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_type text NOT NULL CHECK (scope_type IN ('DEVIS_LINE','DEVIS','AFFAIRE','OF')),
  scope_ref text NOT NULL CHECK (btrim(scope_ref) <> ''),
  basis text NOT NULL CHECK (basis IN ('PLANNED','ACTUAL')),
  input_key text NOT NULL CHECK (btrim(input_key) <> ''),
  input_kind text NOT NULL CHECK (input_kind IN ('REVENUE','COST')),
  category text NULL CHECK (category IS NULL OR category IN (
    'MATERIAL','PURCHASE','SUBCONTRACTING','MACHINE','OPERATOR','CONTROL',
    'TOOLING','PACKAGING','TRANSPORT','SCRAP','OVERHEAD'
  )),
  availability text NOT NULL CHECK (availability IN ('PROVIDED','NOT_APPLICABLE')),
  amount_ht numeric(18,6) NULL CHECK (amount_ht IS NULL OR amount_ht >= 0),
  quantity numeric(18,6) NULL CHECK (quantity IS NULL OR quantity >= 0),
  rate_id uuid NULL REFERENCES public.margin_rates(id) ON DELETE RESTRICT,
  currency char(3) NOT NULL DEFAULT 'EUR' CHECK (currency = 'EUR'),
  source_type text NOT NULL CHECK (btrim(source_type) <> ''),
  source_ref text NULL,
  observed_at timestamptz NULL,
  assumption text NULL,
  assumption_date date NULL,
  supersedes_id uuid NULL REFERENCES public.margin_input_versions(id) ON DELETE RESTRICT,
  created_by integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT margin_input_versions_kind_ck CHECK (
    (input_kind = 'REVENUE' AND category IS NULL) OR
    (input_kind = 'COST' AND category IS NOT NULL)
  ),
  CONSTRAINT margin_input_versions_value_ck CHECK (
    (availability = 'NOT_APPLICABLE' AND amount_ht IS NULL AND quantity IS NULL AND rate_id IS NULL) OR
    (availability = 'PROVIDED' AND (amount_ht IS NOT NULL OR rate_id IS NOT NULL))
  ),
  CONSTRAINT margin_input_versions_assumption_ck CHECK (
    assumption IS NULL OR (btrim(assumption) <> '' AND assumption_date IS NOT NULL)
  ),
  CONSTRAINT margin_input_versions_no_self_ck CHECK (supersedes_id IS NULL OR supersedes_id <> id)
);

CREATE UNIQUE INDEX IF NOT EXISTS margin_input_versions_supersedes_uk
  ON public.margin_input_versions(supersedes_id) WHERE supersedes_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS margin_input_versions_lookup_idx
  ON public.margin_input_versions(scope_type, scope_ref, basis, input_key, created_at DESC);

CREATE TABLE IF NOT EXISTS public.margin_recalculations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_type text NOT NULL CHECK (scope_type IN ('DEVIS_LINE','DEVIS','AFFAIRE','OF')),
  scope_ref text NOT NULL CHECK (btrim(scope_ref) <> ''),
  basis text NOT NULL CHECK (basis IN ('PLANNED','ACTUAL')),
  as_of date NOT NULL,
  formula_version text NOT NULL,
  calculation_hash char(64) NOT NULL CHECK (calculation_hash ~ '^[0-9a-f]{64}$'),
  input_snapshot jsonb NOT NULL,
  result_snapshot jsonb NOT NULL,
  created_by integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS margin_recalculations_lookup_idx
  ON public.margin_recalculations(scope_type, scope_ref, basis, created_at DESC);

CREATE OR REPLACE FUNCTION public.fn_margin_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; create a superseding version instead', TG_TABLE_NAME
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS trg_margin_rate_versions_append_only ON public.margin_rate_versions;
CREATE TRIGGER trg_margin_rate_versions_append_only
  BEFORE UPDATE OR DELETE ON public.margin_rate_versions
  FOR EACH ROW EXECUTE FUNCTION public.fn_margin_append_only();

DROP TRIGGER IF EXISTS trg_margin_rates_append_only ON public.margin_rates;
CREATE TRIGGER trg_margin_rates_append_only
  BEFORE UPDATE OR DELETE ON public.margin_rates
  FOR EACH ROW EXECUTE FUNCTION public.fn_margin_append_only();

DROP TRIGGER IF EXISTS trg_margin_input_versions_append_only ON public.margin_input_versions;
CREATE TRIGGER trg_margin_input_versions_append_only
  BEFORE UPDATE OR DELETE ON public.margin_input_versions
  FOR EACH ROW EXECUTE FUNCTION public.fn_margin_append_only();

DROP TRIGGER IF EXISTS trg_margin_recalculations_append_only ON public.margin_recalculations;
CREATE TRIGGER trg_margin_recalculations_append_only
  BEFORE UPDATE OR DELETE ON public.margin_recalculations
  FOR EACH ROW EXECUTE FUNCTION public.fn_margin_append_only();

COMMENT ON TABLE public.margin_input_versions IS
  'Entrees de marge datees et append-only. Une absence reste absente; NOT_APPLICABLE est explicite.';
COMMENT ON TABLE public.margin_recalculations IS
  'Preuves de recalcul immuables: formule, entrees, resultat et empreinte SHA-256.';

COMMIT;
