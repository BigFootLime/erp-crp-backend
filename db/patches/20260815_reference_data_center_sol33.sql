-- SOL-33 - governed reference-data control plane.
--
-- The canonical values stay in their owning business tables.  These tables
-- add the missing proposal, approval, comparison and immutable version trail;
-- they never seed or invent a business value.

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $preflight$
BEGIN
  IF to_regclass('public.users') IS NULL
     OR to_regclass('public.erp_audit_logs') IS NULL
     OR to_regclass('public.production_cost_center_rates') IS NULL
     OR to_regclass('public.programmation_calendars') IS NULL
     OR to_regclass('public.fournisseur_catalogue') IS NULL
     OR to_regclass('public.fournisseur_catalogue_prix_history') IS NULL
     OR to_regclass('public.units') IS NULL
     OR to_regclass('public.erp_settings') IS NULL THEN
    RAISE EXCEPTION 'SOL-33 prerequisites are missing; run the migration preflight first';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app') THEN
    RAISE EXCEPTION 'SOL-33 runtime role cerp_app is missing';
  END IF;
END
$preflight$;

CREATE TABLE public.reference_data_change_sets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status text NOT NULL CHECK (status IN ('PENDING_APPROVAL','APPROVED','REJECTED','APPLIED','FAILED')),
  effective_from date NOT NULL,
  effective_to date NULL,
  reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 5 AND 2000),
  source text NOT NULL CHECK (char_length(btrim(source)) BETWEEN 3 AND 500),
  reliability text NOT NULL CHECK (reliability IN ('DECLARED','VERIFIED')),
  changes jsonb NOT NULL CHECK (jsonb_typeof(changes) = 'array' AND jsonb_array_length(changes) BETWEEN 1 AND 200),
  comparison jsonb NOT NULL CHECK (jsonb_typeof(comparison) = 'array'),
  affected_modules text[] NOT NULL CHECK (cardinality(affected_modules) > 0),
  expected_snapshot_sha256 char(64) NOT NULL CHECK (expected_snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  request_sha256 char(64) NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 120),
  proposed_by integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  approved_by integer NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  approved_at timestamptz NULL,
  rejected_by integer NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  rejected_at timestamptz NULL,
  rejection_reason text NULL,
  applied_by integer NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  applied_at timestamptz NULL,
  failure_code text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reference_data_change_period_ck CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT reference_data_change_approval_ck CHECK (
    (status IN ('APPROVED','APPLIED','FAILED') AND approved_by IS NOT NULL AND approved_at IS NOT NULL)
    OR (status NOT IN ('APPROVED','APPLIED','FAILED') AND approved_by IS NULL AND approved_at IS NULL)
  ),
  CONSTRAINT reference_data_change_rejection_ck CHECK (
    (status = 'REJECTED' AND rejected_by IS NOT NULL AND rejected_at IS NOT NULL
      AND rejection_reason IS NOT NULL AND char_length(btrim(rejection_reason)) >= 5)
    OR (status <> 'REJECTED' AND rejected_by IS NULL AND rejected_at IS NULL AND rejection_reason IS NULL)
  ),
  CONSTRAINT reference_data_change_application_ck CHECK (
    (status = 'APPLIED' AND applied_by IS NOT NULL AND applied_at IS NOT NULL AND failure_code IS NULL)
    OR (status <> 'APPLIED' AND applied_by IS NULL AND applied_at IS NULL)
  ),
  CONSTRAINT reference_data_change_actor_separation_ck CHECK (
    approved_by IS NULL OR approved_by <> proposed_by
  ),
  CONSTRAINT reference_data_change_idempotency_uq UNIQUE (proposed_by, idempotency_key)
);

CREATE INDEX reference_data_change_queue_idx
  ON public.reference_data_change_sets (status, effective_from, created_at);

CREATE TABLE public.reference_data_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_code text NOT NULL CHECK (dataset_code IN (
    'HOURLY_RATES','PRODUCTION_CALENDARS','MATERIAL_COSTS','UNIT_CONVERSIONS',
    'SUPPLIER_LEAD_TIMES','STOCK_VALUATION'
  )),
  record_key text NOT NULL CHECK (btrim(record_key) <> ''),
  version integer NOT NULL CHECK (version > 0),
  effective_from date NOT NULL,
  effective_to date NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  source text NOT NULL CHECK (btrim(source) <> ''),
  reliability text NOT NULL CHECK (reliability IN ('DECLARED','VERIFIED')),
  reason text NOT NULL CHECK (char_length(btrim(reason)) >= 5),
  change_set_id uuid NOT NULL REFERENCES public.reference_data_change_sets(id) ON DELETE RESTRICT,
  created_by integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  approved_by integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reference_data_version_period_ck CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT reference_data_version_key_uq UNIQUE (dataset_code, record_key, version),
  CONSTRAINT reference_data_version_change_record_uq UNIQUE (change_set_id, dataset_code, record_key)
);

CREATE INDEX reference_data_versions_effective_idx
  ON public.reference_data_versions (dataset_code, record_key, effective_from DESC, effective_to);

CREATE TABLE public.reference_data_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  change_set_id uuid NOT NULL REFERENCES public.reference_data_change_sets(id) ON DELETE RESTRICT,
  decision text NOT NULL CHECK (decision IN ('PROPOSED','APPROVED','REJECTED','APPLIED','FAILED')),
  reason text NOT NULL CHECK (char_length(btrim(reason)) >= 3),
  actor_user_id integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 120),
  request_sha256 char(64) NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reference_data_decision_idempotency_uq UNIQUE (actor_user_id, decision, idempotency_key)
);

CREATE INDEX reference_data_decisions_change_idx
  ON public.reference_data_decisions (change_set_id, created_at);

CREATE FUNCTION public.fn_reference_data_version_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $guard$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'reference_data_versions is append-only; create a new dated version'
      USING ERRCODE = '55000';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.dataset_code || ':' || NEW.record_key, 33));
  -- A new open version supersedes the previous open version logically.  We do
  -- not rewrite that evidence row; consumers resolve the greatest
  -- effective_from.  Explicitly bounded periods, however, may never overlap,
  -- and inserting an older date is a forbidden silent retroactive change.
  IF EXISTS (
    SELECT 1
      FROM public.reference_data_versions existing
     WHERE existing.dataset_code = NEW.dataset_code
       AND existing.record_key = NEW.record_key
       AND existing.effective_from >= NEW.effective_from
  ) THEN
    RAISE EXCEPTION 'non-monotonic reference-data version for %/%', NEW.dataset_code, NEW.record_key
      USING ERRCODE = '23505';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM public.reference_data_versions existing
     WHERE existing.dataset_code = NEW.dataset_code
       AND existing.record_key = NEW.record_key
       AND existing.effective_to IS NOT NULL
       AND daterange(existing.effective_from, existing.effective_to + 1, '[)')
           && daterange(NEW.effective_from, COALESCE(NEW.effective_to + 1, 'infinity'::date), '[)')
  ) THEN
    RAISE EXCEPTION 'overlapping bounded reference-data version for %/%', NEW.dataset_code, NEW.record_key
      USING ERRCODE = '23P01';
  END IF;
  RETURN NEW;
END
$guard$;

CREATE TRIGGER reference_data_versions_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.reference_data_versions
  FOR EACH ROW EXECUTE FUNCTION public.fn_reference_data_version_guard();

CREATE FUNCTION public.fn_reference_data_decision_append_only()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $append_only$
BEGIN
  RAISE EXCEPTION 'reference_data_decisions is append-only' USING ERRCODE = '55000';
END
$append_only$;

CREATE TRIGGER reference_data_decisions_append_only
  BEFORE UPDATE OR DELETE ON public.reference_data_decisions
  FOR EACH ROW EXECUTE FUNCTION public.fn_reference_data_decision_append_only();

ALTER TABLE public.reference_data_change_sets OWNER TO cerp_app;
ALTER TABLE public.reference_data_versions OWNER TO cerp_app;
ALTER TABLE public.reference_data_decisions OWNER TO cerp_app;
ALTER FUNCTION public.fn_reference_data_version_guard() OWNER TO cerp_app;
ALTER FUNCTION public.fn_reference_data_decision_append_only() OWNER TO cerp_app;

REVOKE ALL ON TABLE public.reference_data_change_sets FROM PUBLIC, cerp_app;
REVOKE ALL ON TABLE public.reference_data_versions FROM PUBLIC, cerp_app;
REVOKE ALL ON TABLE public.reference_data_decisions FROM PUBLIC, cerp_app;
GRANT SELECT, INSERT, UPDATE ON TABLE public.reference_data_change_sets TO cerp_app;
GRANT SELECT, INSERT ON TABLE public.reference_data_versions TO cerp_app;
GRANT SELECT, INSERT ON TABLE public.reference_data_decisions TO cerp_app;
REVOKE ALL ON FUNCTION public.fn_reference_data_version_guard() FROM PUBLIC, cerp_app;
REVOKE ALL ON FUNCTION public.fn_reference_data_decision_append_only() FROM PUBLIC, cerp_app;
GRANT EXECUTE ON FUNCTION public.fn_reference_data_version_guard() TO cerp_app;
GRANT EXECUTE ON FUNCTION public.fn_reference_data_decision_append_only() TO cerp_app;

COMMENT ON TABLE public.reference_data_change_sets IS
  'SOL-33 governed proposals with before/after comparison, four-eyes approval and optimistic snapshot hash.';
COMMENT ON TABLE public.reference_data_versions IS
  'SOL-33 immutable governance versions. Canonical business values remain in their owning domain tables.';
COMMENT ON TABLE public.reference_data_decisions IS
  'SOL-33 immutable decision trail for proposal, approval, rejection, application and failure.';

COMMIT;
