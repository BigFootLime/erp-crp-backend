-- SOL-18 supplier performance evidence, promise history and actionable anomalies.
-- Additive and repeat-safe through the canonical schema_migrations runner.
BEGIN;

DO $guard$
BEGIN
  IF to_regclass('public.commande_fournisseur') IS NULL
     OR to_regclass('public.commande_fournisseur_ligne') IS NULL
     OR to_regclass('public.receptions_fournisseurs') IS NULL
     OR to_regclass('public.reception_fournisseur_lignes') IS NULL
     OR to_regclass('public.reception_incoming_inspections') IS NULL
     OR to_regclass('public.lots') IS NULL THEN
    RAISE EXCEPTION 'SOL-18 prerequisites are missing; apply supplier-order, reception, stock and quality patches first';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app') THEN
    RAISE EXCEPTION 'SOL-18 runtime role cerp_app is missing';
  END IF;
END
$guard$;

CREATE TABLE public.procurement_promised_date_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  commande_id uuid NOT NULL REFERENCES public.commande_fournisseur(id) ON DELETE RESTRICT,
  ligne_id uuid NULL REFERENCES public.commande_fournisseur_ligne(id) ON DELETE RESTRICT,
  previous_date date NULL,
  promised_date date NOT NULL,
  reason_code text NOT NULL CHECK (reason_code IN (
    'SUPPLIER_ACKNOWLEDGEMENT','SUPPLIER_DELAY','SUPPLIER_ADVANCE',
    'PARTIAL_SHIPMENT','ORDER_CORRECTION','OTHER'
  )),
  note text NULL CHECK (note IS NULL OR char_length(note) <= 1000),
  actor_user_id integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT procurement_promise_change_ck CHECK (
    reason_code = 'SUPPLIER_ACKNOWLEDGEMENT' OR previous_date IS DISTINCT FROM promised_date
  ),
  CONSTRAINT procurement_promise_other_note_ck CHECK (reason_code <> 'OTHER' OR note IS NOT NULL)
);
CREATE INDEX procurement_promises_order_idx
  ON public.procurement_promised_date_events (commande_id, created_at DESC);
CREATE INDEX procurement_promises_line_idx
  ON public.procurement_promised_date_events (ligne_id, created_at DESC) WHERE ligne_id IS NOT NULL;

CREATE TABLE public.procurement_anomaly_actions (
  anomaly_key text PRIMARY KEY CHECK (anomaly_key ~ '^[A-Z_]+:[0-9a-f]{24}$'),
  owner_user_id integer NULL REFERENCES public.users(id) ON DELETE SET NULL,
  next_action text NOT NULL CHECK (char_length(next_action) BETWEEN 3 AND 500),
  due_date date NOT NULL,
  status text NOT NULL CHECK (status IN ('OPEN','IN_PROGRESS','RESOLVED','DISMISSED')),
  resolution_note text NULL CHECK (resolution_note IS NULL OR char_length(resolution_note) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  CONSTRAINT procurement_anomaly_close_note_ck CHECK (
    status NOT IN ('RESOLVED','DISMISSED') OR resolution_note IS NOT NULL
  )
);
CREATE INDEX procurement_anomaly_queue_idx
  ON public.procurement_anomaly_actions (status, due_date, owner_user_id);

CREATE TABLE public.procurement_policy_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_type text NOT NULL CHECK (scope_type IN ('COMPANY','SUPPLIER','ARTICLE','FAMILY')),
  scope_id text NULL,
  valid_from date NOT NULL,
  price_tolerance_pct numeric(7,4) NULL CHECK (price_tolerance_pct BETWEEN 0 AND 100),
  over_receipt_tolerance_pct numeric(7,4) NOT NULL DEFAULT 0 CHECK (over_receipt_tolerance_pct BETWEEN 0 AND 100),
  lead_grace_days integer NOT NULL DEFAULT 0 CHECK (lead_grace_days BETWEEN 0 AND 365),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  CONSTRAINT procurement_policy_scope_ck CHECK (
    (scope_type = 'COMPANY' AND scope_id IS NULL)
    OR (scope_type <> 'COMPANY' AND scope_id IS NOT NULL)
  ),
  CONSTRAINT procurement_policy_scope_date_uniq UNIQUE NULLS NOT DISTINCT (scope_type, scope_id, valid_from)
);
CREATE INDEX procurement_policy_effective_idx
  ON public.procurement_policy_versions (scope_type, scope_id, valid_from DESC);

CREATE TABLE public.procurement_command_receipts (
  action text NOT NULL CHECK (action IN ('ANOMALY_ACTION','PROMISED_DATE','POLICY_VERSION')),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 120),
  request_hash char(64) NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  actor_user_id integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  response_snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (action, idempotency_key)
);

CREATE FUNCTION public.fn_procurement_evidence_append_only()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $append_only$
BEGIN
  RAISE EXCEPTION '% is append-only; add a new procurement event or policy version instead', TG_TABLE_NAME
    USING ERRCODE = '55000';
END
$append_only$;

CREATE TRIGGER procurement_promises_append_only
  BEFORE UPDATE OR DELETE ON public.procurement_promised_date_events
  FOR EACH ROW EXECUTE FUNCTION public.fn_procurement_evidence_append_only();
CREATE TRIGGER procurement_policies_append_only
  BEFORE UPDATE OR DELETE ON public.procurement_policy_versions
  FOR EACH ROW EXECUTE FUNCTION public.fn_procurement_evidence_append_only();
CREATE TRIGGER procurement_receipts_append_only
  BEFORE UPDATE OR DELETE ON public.procurement_command_receipts
  FOR EACH ROW EXECUTE FUNCTION public.fn_procurement_evidence_append_only();

ALTER TABLE public.procurement_promised_date_events OWNER TO cerp_app;
ALTER TABLE public.procurement_anomaly_actions OWNER TO cerp_app;
ALTER TABLE public.procurement_policy_versions OWNER TO cerp_app;
ALTER TABLE public.procurement_command_receipts OWNER TO cerp_app;
ALTER FUNCTION public.fn_procurement_evidence_append_only() OWNER TO cerp_app;

REVOKE ALL ON TABLE public.procurement_promised_date_events FROM PUBLIC, cerp_app;
REVOKE ALL ON TABLE public.procurement_anomaly_actions FROM PUBLIC, cerp_app;
REVOKE ALL ON TABLE public.procurement_policy_versions FROM PUBLIC, cerp_app;
REVOKE ALL ON TABLE public.procurement_command_receipts FROM PUBLIC, cerp_app;
GRANT SELECT, INSERT ON TABLE public.procurement_promised_date_events TO cerp_app;
GRANT SELECT, INSERT, UPDATE ON TABLE public.procurement_anomaly_actions TO cerp_app;
GRANT SELECT, INSERT ON TABLE public.procurement_policy_versions TO cerp_app;
GRANT SELECT, INSERT ON TABLE public.procurement_command_receipts TO cerp_app;
REVOKE ALL ON FUNCTION public.fn_procurement_evidence_append_only() FROM PUBLIC, cerp_app;
GRANT EXECUTE ON FUNCTION public.fn_procurement_evidence_append_only() TO cerp_app;

COMMENT ON TABLE public.procurement_promised_date_events IS
  'SOL-18 append-only supplier promise history. Existing pre-SOL-18 promise values remain explicitly unversioned.';
COMMENT ON TABLE public.procurement_anomaly_actions IS
  'SOL-18 mutable triage overlay for deterministic procurement anomalies; every mutation is also written to the central audit log.';
COMMENT ON TABLE public.procurement_policy_versions IS
  'SOL-18 dated tolerance policies. No implicit price tolerance is assumed when no version exists.';
COMMENT ON TABLE public.procurement_command_receipts IS
  'SOL-18 idempotency receipts for anomaly triage, promise revisions and tolerance versions.';

COMMIT;
