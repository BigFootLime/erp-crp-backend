-- SOL-19 versioned stock decision policy. Calculated projections remain read-only.
BEGIN;

DO $guard$
BEGIN
  IF to_regclass('public.stock_levels') IS NULL
     OR to_regclass('public.stock_movements') IS NULL
     OR to_regclass('public.stock_reservations') IS NULL
     OR to_regclass('public.stock_inventory_sessions') IS NULL
     OR to_regclass('public.commande_fournisseur_ligne') IS NULL
     OR to_regclass('public.v_stock_availability_225') IS NULL THEN
    RAISE EXCEPTION 'SOL-19 prerequisites are missing; apply stock traceability, inventory and supplier-order patches first';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app') THEN
    RAISE EXCEPTION 'SOL-19 runtime role cerp_app is missing';
  END IF;
END
$guard$;

CREATE TABLE public.stock_intelligence_policy_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  valid_from date NOT NULL,
  abc_lookback_days integer NOT NULL CHECK (abc_lookback_days BETWEEN 30 AND 1095),
  abc_a_cumulative_pct numeric(7,4) NOT NULL CHECK (abc_a_cumulative_pct > 0 AND abc_a_cumulative_pct < 100),
  abc_b_cumulative_pct numeric(7,4) NOT NULL CHECK (abc_b_cumulative_pct > 0 AND abc_b_cumulative_pct <= 100),
  dormant_after_days integer NOT NULL CHECK (dormant_after_days BETWEEN 1 AND 3650),
  consumption_lookback_days integer NOT NULL CHECK (consumption_lookback_days BETWEEN 28 AND 365),
  coverage_weeks integer NOT NULL CHECK (coverage_weeks BETWEEN 1 AND 13),
  inventory_tolerance_pct numeric(7,4) NOT NULL CHECK (inventory_tolerance_pct BETWEEN 0 AND 100),
  inventory_absolute_tolerance_qty numeric(18,3) NOT NULL CHECK (inventory_absolute_tolerance_qty >= 0),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  CONSTRAINT stock_intelligence_abc_order_ck CHECK (abc_a_cumulative_pct < abc_b_cumulative_pct),
  CONSTRAINT stock_intelligence_policy_date_uq UNIQUE (valid_from)
);
CREATE INDEX stock_intelligence_policy_effective_idx
  ON public.stock_intelligence_policy_versions (valid_from DESC, created_at DESC);

CREATE TABLE public.stock_intelligence_command_receipts (
  idempotency_key text PRIMARY KEY CHECK (char_length(idempotency_key) BETWEEN 8 AND 120),
  request_hash char(64) NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  actor_user_id integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  response_snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION public.fn_stock_intelligence_evidence_append_only()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $append_only$
BEGIN
  RAISE EXCEPTION '% is append-only; create a new dated stock policy instead', TG_TABLE_NAME
    USING ERRCODE = '55000';
END
$append_only$;

CREATE TRIGGER stock_intelligence_policies_append_only
  BEFORE UPDATE OR DELETE ON public.stock_intelligence_policy_versions
  FOR EACH ROW EXECUTE FUNCTION public.fn_stock_intelligence_evidence_append_only();
CREATE TRIGGER stock_intelligence_receipts_append_only
  BEFORE UPDATE OR DELETE ON public.stock_intelligence_command_receipts
  FOR EACH ROW EXECUTE FUNCTION public.fn_stock_intelligence_evidence_append_only();

ALTER TABLE public.stock_intelligence_policy_versions OWNER TO cerp_app;
ALTER TABLE public.stock_intelligence_command_receipts OWNER TO cerp_app;
ALTER FUNCTION public.fn_stock_intelligence_evidence_append_only() OWNER TO cerp_app;
REVOKE ALL ON TABLE public.stock_intelligence_policy_versions FROM PUBLIC, cerp_app;
REVOKE ALL ON TABLE public.stock_intelligence_command_receipts FROM PUBLIC, cerp_app;
GRANT SELECT, INSERT ON TABLE public.stock_intelligence_policy_versions TO cerp_app;
GRANT SELECT, INSERT ON TABLE public.stock_intelligence_command_receipts TO cerp_app;
REVOKE ALL ON FUNCTION public.fn_stock_intelligence_evidence_append_only() FROM PUBLIC, cerp_app;
GRANT EXECUTE ON FUNCTION public.fn_stock_intelligence_evidence_append_only() TO cerp_app;

COMMENT ON TABLE public.stock_intelligence_policy_versions IS
  'SOL-19 append-only versions of ABC, dormancy, coverage and inventory-accuracy parameters. Empty means the documented system default is active and explicitly reported as such.';
COMMENT ON TABLE public.stock_intelligence_command_receipts IS
  'SOL-19 idempotency receipts for stock policy creation. Simulations never write a receipt or business data.';

COMMIT;
