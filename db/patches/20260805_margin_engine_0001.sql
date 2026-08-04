-- CERP FEAT-0001 - Moteur de marge auditable.
-- Creation exacte et fail-safe: aucun artefact preexistant n'est adopte.

DO $preexisting_guard$
BEGIN
  IF to_regclass('public.users') IS NULL THEN
    RAISE EXCEPTION 'margin engine patch: required users table is missing';
  END IF;
  IF to_regrole('cerp_app') IS NULL THEN
    RAISE EXCEPTION 'margin engine patch: required role cerp_app is missing';
  END IF;

  IF to_regclass('public.margin_rate_versions') IS NOT NULL
     OR to_regclass('public.margin_rates') IS NOT NULL
     OR to_regclass('public.margin_input_versions') IS NOT NULL
     OR to_regclass('public.margin_recalculations') IS NOT NULL
     OR to_regprocedure('public.fn_margin_append_only()') IS NOT NULL
     OR EXISTS (
       SELECT 1
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relname = ANY (ARRAY[
           'margin_rate_versions_pkey',
           'margin_rate_versions_code_version_uk',
           'margin_rate_versions_supersedes_uk',
           'margin_rate_versions_effective_idx',
           'margin_rates_pkey',
           'margin_rates_version_code_scope_uk',
           'margin_rates_resolution_idx',
           'margin_rates_version_code_scope_coalesced_uk',
           'margin_input_versions_pkey',
           'margin_input_versions_supersedes_uk',
           'margin_input_versions_lookup_idx',
           'margin_recalculations_pkey',
           'margin_recalculations_lookup_idx'
         ])
     ) THEN
    RAISE EXCEPTION 'margin engine patch: target artifact already exists without this migration ledger entry';
  END IF;
END
$preexisting_guard$;

CREATE TABLE public.margin_rate_versions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  code text NOT NULL,
  version integer NOT NULL,
  currency char(3) NOT NULL DEFAULT 'EUR',
  effective_from date NOT NULL,
  effective_to date NULL,
  source text NOT NULL,
  assumption_date date NOT NULL,
  notes text NULL,
  supersedes_id uuid NULL,
  created_by integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT margin_rate_versions_pkey PRIMARY KEY (id),
  CONSTRAINT margin_rate_versions_version_ck CHECK (version > 0),
  CONSTRAINT margin_rate_versions_currency_ck CHECK (currency = 'EUR'),
  CONSTRAINT margin_rate_versions_source_ck CHECK (btrim(source) <> ''),
  CONSTRAINT margin_rate_versions_dates_ck CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT margin_rate_versions_code_version_uk UNIQUE (code, version),
  CONSTRAINT margin_rate_versions_no_self_ck CHECK (supersedes_id IS NULL OR supersedes_id <> id),
  CONSTRAINT margin_rate_versions_supersedes_fk FOREIGN KEY (supersedes_id)
    REFERENCES public.margin_rate_versions(id) ON DELETE RESTRICT,
  CONSTRAINT margin_rate_versions_created_by_fk FOREIGN KEY (created_by)
    REFERENCES public.users(id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX margin_rate_versions_supersedes_uk
  ON public.margin_rate_versions(supersedes_id) WHERE supersedes_id IS NOT NULL;
CREATE INDEX margin_rate_versions_effective_idx
  ON public.margin_rate_versions(code, effective_from DESC, effective_to);

CREATE TABLE public.margin_rates (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  rate_version_id uuid NOT NULL,
  rate_code text NOT NULL,
  category text NOT NULL,
  scope_type text NOT NULL DEFAULT 'GLOBAL',
  scope_ref text NULL,
  amount numeric(18,6) NOT NULL,
  unit text NOT NULL,
  source_ref text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT margin_rates_pkey PRIMARY KEY (id),
  CONSTRAINT margin_rates_rate_version_fk FOREIGN KEY (rate_version_id)
    REFERENCES public.margin_rate_versions(id) ON DELETE RESTRICT,
  CONSTRAINT margin_rates_rate_code_ck CHECK (btrim(rate_code) <> ''),
  CONSTRAINT margin_rates_category_ck CHECK (category IN (
    'MATERIAL','PURCHASE','SUBCONTRACTING','MACHINE','OPERATOR','CONTROL',
    'TOOLING','PACKAGING','TRANSPORT','SCRAP','OVERHEAD'
  )),
  CONSTRAINT margin_rates_scope_type_ck CHECK (scope_type IN (
    'GLOBAL','USER','MACHINE','COST_CENTER','PIECE_TECHNIQUE'
  )),
  CONSTRAINT margin_rates_amount_ck CHECK (amount >= 0),
  CONSTRAINT margin_rates_unit_ck CHECK (unit IN ('EUR_PER_HOUR','EUR_PER_UNIT','PERCENT_OF_DIRECT_COST')),
  CONSTRAINT margin_rates_scope_ck CHECK (
    (scope_type = 'GLOBAL' AND scope_ref IS NULL) OR
    (scope_type <> 'GLOBAL' AND scope_ref IS NOT NULL AND btrim(scope_ref) <> '')
  ),
  CONSTRAINT margin_rates_version_code_scope_uk UNIQUE (rate_version_id, rate_code, scope_type, scope_ref)
);

CREATE INDEX margin_rates_resolution_idx
  ON public.margin_rates(category, scope_type, scope_ref, rate_version_id);
CREATE UNIQUE INDEX margin_rates_version_code_scope_coalesced_uk
  ON public.margin_rates(rate_version_id, rate_code, scope_type, COALESCE(scope_ref, ''));

CREATE TABLE public.margin_input_versions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  scope_type text NOT NULL,
  scope_ref text NOT NULL,
  basis text NOT NULL,
  input_key text NOT NULL,
  input_kind text NOT NULL,
  category text NULL,
  availability text NOT NULL,
  amount_ht numeric(18,6) NULL,
  quantity numeric(18,6) NULL,
  rate_id uuid NULL,
  rate_effective_at date NULL,
  rate_validation_snapshot jsonb NULL,
  currency char(3) NOT NULL DEFAULT 'EUR',
  source_type text NOT NULL,
  source_ref text NULL,
  observed_at timestamptz NULL,
  assumption text NULL,
  assumption_date date NULL,
  supersedes_id uuid NULL,
  created_by integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT margin_input_versions_pkey PRIMARY KEY (id),
  CONSTRAINT margin_input_versions_scope_type_ck CHECK (scope_type IN ('DEVIS_LINE','DEVIS','AFFAIRE','OF')),
  CONSTRAINT margin_input_versions_scope_ref_ck CHECK (btrim(scope_ref) <> ''),
  CONSTRAINT margin_input_versions_basis_ck CHECK (basis IN ('PLANNED','ACTUAL')),
  CONSTRAINT margin_input_versions_input_key_ck CHECK (btrim(input_key) <> ''),
  CONSTRAINT margin_input_versions_input_kind_ck CHECK (input_kind IN ('REVENUE','COST')),
  CONSTRAINT margin_input_versions_category_ck CHECK (category IS NULL OR category IN (
    'MATERIAL','PURCHASE','SUBCONTRACTING','MACHINE','OPERATOR','CONTROL',
    'TOOLING','PACKAGING','TRANSPORT','SCRAP','OVERHEAD'
  )),
  CONSTRAINT margin_input_versions_availability_ck CHECK (availability IN ('PROVIDED','NOT_APPLICABLE')),
  CONSTRAINT margin_input_versions_amount_ht_ck CHECK (amount_ht IS NULL OR amount_ht >= 0),
  CONSTRAINT margin_input_versions_quantity_ck CHECK (quantity IS NULL OR quantity >= 0),
  CONSTRAINT margin_input_versions_rate_fk FOREIGN KEY (rate_id)
    REFERENCES public.margin_rates(id) ON DELETE RESTRICT,
  CONSTRAINT margin_input_versions_currency_ck CHECK (currency = 'EUR'),
  CONSTRAINT margin_input_versions_source_type_ck CHECK (btrim(source_type) <> ''),
  CONSTRAINT margin_input_versions_supersedes_fk FOREIGN KEY (supersedes_id)
    REFERENCES public.margin_input_versions(id) ON DELETE RESTRICT,
  CONSTRAINT margin_input_versions_created_by_fk FOREIGN KEY (created_by)
    REFERENCES public.users(id) ON DELETE RESTRICT,
  CONSTRAINT margin_input_versions_kind_ck CHECK (
    (input_kind = 'REVENUE' AND category IS NULL) OR
    (input_kind = 'COST' AND category IS NOT NULL)
  ),
  CONSTRAINT margin_input_versions_value_ck CHECK (
    (availability = 'NOT_APPLICABLE'
      AND amount_ht IS NULL AND quantity IS NULL AND rate_id IS NULL
      AND rate_effective_at IS NULL AND rate_validation_snapshot IS NULL) OR
    (availability = 'PROVIDED' AND (
      (amount_ht IS NOT NULL AND rate_id IS NULL AND quantity IS NULL
        AND rate_effective_at IS NULL AND rate_validation_snapshot IS NULL) OR
      (amount_ht IS NULL AND rate_id IS NOT NULL
        AND rate_effective_at IS NOT NULL AND rate_validation_snapshot IS NOT NULL)
    ))
  ),
  CONSTRAINT margin_input_versions_rate_snapshot_ck CHECK (
    rate_validation_snapshot IS NULL OR jsonb_typeof(rate_validation_snapshot) = 'object'
  ),
  CONSTRAINT margin_input_versions_assumption_ck CHECK (
    assumption IS NULL OR (btrim(assumption) <> '' AND assumption_date IS NOT NULL)
  ),
  CONSTRAINT margin_input_versions_no_self_ck CHECK (supersedes_id IS NULL OR supersedes_id <> id)
);

CREATE UNIQUE INDEX margin_input_versions_supersedes_uk
  ON public.margin_input_versions(supersedes_id) WHERE supersedes_id IS NOT NULL;
CREATE INDEX margin_input_versions_lookup_idx
  ON public.margin_input_versions(scope_type, scope_ref, basis, input_key, created_at DESC);

CREATE TABLE public.margin_recalculations (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  scope_type text NOT NULL,
  scope_ref text NOT NULL,
  basis text NOT NULL,
  as_of date NOT NULL,
  formula_version text NOT NULL,
  calculation_hash char(64) NOT NULL,
  input_snapshot jsonb NOT NULL,
  result_snapshot jsonb NOT NULL,
  created_by integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT margin_recalculations_pkey PRIMARY KEY (id),
  CONSTRAINT margin_recalculations_scope_type_ck CHECK (scope_type IN ('DEVIS_LINE','DEVIS','AFFAIRE','OF')),
  CONSTRAINT margin_recalculations_scope_ref_ck CHECK (btrim(scope_ref) <> ''),
  CONSTRAINT margin_recalculations_basis_ck CHECK (basis IN ('PLANNED','ACTUAL')),
  CONSTRAINT margin_recalculations_hash_ck CHECK (calculation_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT margin_recalculations_created_by_fk FOREIGN KEY (created_by)
    REFERENCES public.users(id) ON DELETE RESTRICT
);

CREATE INDEX margin_recalculations_lookup_idx
  ON public.margin_recalculations(scope_type, scope_ref, basis, created_at DESC);

CREATE FUNCTION public.fn_margin_append_only()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $append_only$
BEGIN
  RAISE EXCEPTION '% is append-only; create a superseding version instead', TG_TABLE_NAME
    USING ERRCODE = '55000';
END
$append_only$;

CREATE TRIGGER trg_margin_rate_versions_append_only
  BEFORE UPDATE OR DELETE ON public.margin_rate_versions
  FOR EACH ROW EXECUTE FUNCTION public.fn_margin_append_only();

CREATE TRIGGER trg_margin_rates_append_only
  BEFORE UPDATE OR DELETE ON public.margin_rates
  FOR EACH ROW EXECUTE FUNCTION public.fn_margin_append_only();

CREATE TRIGGER trg_margin_input_versions_append_only
  BEFORE UPDATE OR DELETE ON public.margin_input_versions
  FOR EACH ROW EXECUTE FUNCTION public.fn_margin_append_only();

CREATE TRIGGER trg_margin_recalculations_append_only
  BEFORE UPDATE OR DELETE ON public.margin_recalculations
  FOR EACH ROW EXECUTE FUNCTION public.fn_margin_append_only();

COMMENT ON TABLE public.margin_input_versions IS
  'Entrees de marge datees et append-only. Une absence reste absente; NOT_APPLICABLE est explicite.';
COMMENT ON TABLE public.margin_recalculations IS
  'Preuves de recalcul immuables: formule, entrees, resultat et empreinte SHA-256.';
COMMENT ON FUNCTION public.fn_margin_append_only() IS
  'Refuse UPDATE et DELETE sur les quatre relations de preuve du moteur de marge.';

ALTER TABLE public.margin_rate_versions OWNER TO cerp_app;
ALTER TABLE public.margin_rates OWNER TO cerp_app;
ALTER TABLE public.margin_input_versions OWNER TO cerp_app;
ALTER TABLE public.margin_recalculations OWNER TO cerp_app;
ALTER FUNCTION public.fn_margin_append_only() OWNER TO cerp_app;

REVOKE ALL ON TABLE public.margin_rate_versions FROM PUBLIC;
REVOKE ALL ON TABLE public.margin_rates FROM PUBLIC;
REVOKE ALL ON TABLE public.margin_input_versions FROM PUBLIC;
REVOKE ALL ON TABLE public.margin_recalculations FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_margin_append_only() FROM PUBLIC;

GRANT SELECT, INSERT ON TABLE public.margin_rate_versions TO cerp_app;
GRANT SELECT, INSERT ON TABLE public.margin_rates TO cerp_app;
GRANT SELECT, INSERT ON TABLE public.margin_input_versions TO cerp_app;
GRANT SELECT, INSERT ON TABLE public.margin_recalculations TO cerp_app;
GRANT EXECUTE ON FUNCTION public.fn_margin_append_only() TO cerp_app;
