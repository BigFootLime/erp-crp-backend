-- SOL-17 — Commercial reliability: quote decisions, reminders, discount approvals
-- and explicit customer-order cancellation evidence.
--
-- This migration is additive. It does not infer or backfill historical events:
-- an unknown send/decision date must remain unknown instead of being fabricated.

BEGIN;

DO $guard$
BEGIN
  IF to_regclass('public.cerp_schema_migrations') IS NULL
     OR to_regclass('public.devis') IS NULL
     OR to_regclass('public.commande_client') IS NULL
     OR to_regclass('public.commande_historique') IS NULL
     OR to_regclass('public.commande_client_event_log') IS NULL
     OR to_regclass('public.users') IS NULL
     OR to_regclass('public.erp_audit_logs') IS NULL
     OR to_regrole('cerp_app') IS NULL THEN
    RAISE EXCEPTION 'SOL-17: prerequisite table or runtime role is missing';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.cerp_schema_migrations
    WHERE filename = '20260812_commercial_reliability_sol17.sql'
  ) THEN
    RAISE EXCEPTION 'SOL-17: migration ledger already exists; use the patch runner';
  END IF;

  IF to_regclass('public.commercial_quote_events') IS NOT NULL
     OR to_regclass('public.commercial_order_cancellations') IS NOT NULL
     OR to_regclass('public.commercial_command_receipts') IS NOT NULL
     OR to_regprocedure('public.fn_commercial_evidence_append_only()') IS NOT NULL THEN
    RAISE EXCEPTION 'SOL-17: target artifact exists without ledger provenance';
  END IF;
END
$guard$;

CREATE TABLE public.commercial_quote_events (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  devis_id bigint NOT NULL,
  event_type text NOT NULL,
  occurred_at timestamptz NOT NULL,
  actor_user_id integer,
  owner_user_id integer,
  reason_code text,
  channel text,
  note text,
  quote_content_hash char(64),
  discount_pct numeric(7,4),
  approval_request_id uuid,
  source text NOT NULL DEFAULT 'APPLICATION',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT commercial_quote_events_pkey PRIMARY KEY (id),
  CONSTRAINT commercial_quote_events_devis_fkey FOREIGN KEY (devis_id)
    REFERENCES public.devis(id) ON DELETE RESTRICT,
  CONSTRAINT commercial_quote_events_actor_fkey FOREIGN KEY (actor_user_id)
    REFERENCES public.users(id) ON DELETE RESTRICT,
  CONSTRAINT commercial_quote_events_owner_fkey FOREIGN KEY (owner_user_id)
    REFERENCES public.users(id) ON DELETE RESTRICT,
  CONSTRAINT commercial_quote_events_type_ck CHECK (event_type IN (
    'SENT','REMINDER_RECORDED','ACCEPTED','LOST','EXPIRED',
    'DISCOUNT_REQUESTED','DISCOUNT_APPROVED','DISCOUNT_REJECTED'
  )),
  CONSTRAINT commercial_quote_events_reason_ck CHECK (
    reason_code IS NULL OR reason_code IN (
      'PRICE','LEAD_TIME','TECHNICAL_FIT','COMPETITOR','BUDGET',
      'NO_DECISION','DUPLICATE','CUSTOMER_CANCELLED','OTHER'
    )
  ),
  CONSTRAINT commercial_quote_events_channel_ck CHECK (
    channel IS NULL OR channel IN ('EMAIL','PHONE','MEETING','OTHER')
  ),
  CONSTRAINT commercial_quote_events_note_ck CHECK (note IS NULL OR char_length(note) <= 1000),
  CONSTRAINT commercial_quote_events_hash_ck CHECK (
    quote_content_hash IS NULL OR quote_content_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT commercial_quote_events_discount_ck CHECK (
    discount_pct IS NULL OR (discount_pct >= 0 AND discount_pct <= 100)
  ),
  CONSTRAINT commercial_quote_events_required_ck CHECK (
    (event_type <> 'REMINDER_RECORDED' OR channel IS NOT NULL)
    AND (event_type <> 'LOST' OR reason_code IS NOT NULL)
    AND (event_type NOT IN ('DISCOUNT_REQUESTED','DISCOUNT_APPROVED','DISCOUNT_REJECTED')
      OR (quote_content_hash IS NOT NULL AND discount_pct IS NOT NULL AND approval_request_id IS NOT NULL))
  ),
  CONSTRAINT commercial_quote_events_source_ck CHECK (source IN ('APPLICATION','MIGRATION_BACKFILL'))
);

CREATE INDEX commercial_quote_events_devis_time_idx
  ON public.commercial_quote_events (devis_id, occurred_at DESC, id DESC);
CREATE INDEX commercial_quote_events_type_time_idx
  ON public.commercial_quote_events (event_type, occurred_at DESC);
CREATE UNIQUE INDEX commercial_quote_reminder_daily_channel_uniq
  ON public.commercial_quote_events (devis_id, channel, ((occurred_at AT TIME ZONE 'Europe/Paris')::date))
  WHERE event_type = 'REMINDER_RECORDED';
CREATE UNIQUE INDEX commercial_quote_discount_request_uniq
  ON public.commercial_quote_events (devis_id, approval_request_id)
  WHERE event_type = 'DISCOUNT_REQUESTED';
CREATE UNIQUE INDEX commercial_quote_discount_content_request_uniq
  ON public.commercial_quote_events (devis_id, quote_content_hash)
  WHERE event_type = 'DISCOUNT_REQUESTED';
CREATE UNIQUE INDEX commercial_quote_discount_decision_uniq
  ON public.commercial_quote_events (approval_request_id)
  WHERE event_type IN ('DISCOUNT_APPROVED','DISCOUNT_REJECTED');

CREATE TABLE public.commercial_order_cancellations (
  commande_id bigint NOT NULL,
  reason_code text NOT NULL,
  note text,
  cancelled_by integer NOT NULL,
  cancelled_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT commercial_order_cancellations_pkey PRIMARY KEY (commande_id),
  CONSTRAINT commercial_order_cancellations_commande_fkey FOREIGN KEY (commande_id)
    REFERENCES public.commande_client(id) ON DELETE RESTRICT,
  CONSTRAINT commercial_order_cancellations_user_fkey FOREIGN KEY (cancelled_by)
    REFERENCES public.users(id) ON DELETE RESTRICT,
  CONSTRAINT commercial_order_cancellations_reason_ck CHECK (reason_code IN (
    'CUSTOMER_CANCELLED','DUPLICATE','COMMERCIAL_ERROR','TECHNICAL_IMPOSSIBILITY','OTHER'
  )),
  CONSTRAINT commercial_order_cancellations_note_ck CHECK (note IS NULL OR char_length(note) <= 1000)
);

CREATE TABLE public.commercial_command_receipts (
  action text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash char(64) NOT NULL,
  actor_user_id integer NOT NULL,
  response_snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT commercial_command_receipts_pkey PRIMARY KEY (action, idempotency_key),
  CONSTRAINT commercial_command_receipts_actor_fkey FOREIGN KEY (actor_user_id)
    REFERENCES public.users(id) ON DELETE RESTRICT,
  CONSTRAINT commercial_command_receipts_action_ck CHECK (action IN (
    'QUOTE_REMINDER','QUOTE_LOSS','DISCOUNT_REQUEST','DISCOUNT_DECISION',
    'EXPIRE_DUE_QUOTES','ORDER_CANCEL'
  )),
  CONSTRAINT commercial_command_receipts_key_ck CHECK (char_length(idempotency_key) BETWEEN 8 AND 120),
  CONSTRAINT commercial_command_receipts_hash_ck CHECK (request_hash ~ '^[0-9a-f]{64}$')
);

CREATE FUNCTION public.fn_commercial_evidence_append_only()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $append_only$
BEGIN
  RAISE EXCEPTION '% is append-only; add a new commercial event instead', TG_TABLE_NAME
    USING ERRCODE = '55000';
END
$append_only$;

CREATE TRIGGER commercial_quote_events_append_only
  BEFORE UPDATE OR DELETE ON public.commercial_quote_events
  FOR EACH ROW EXECUTE FUNCTION public.fn_commercial_evidence_append_only();
CREATE TRIGGER commercial_order_cancellations_append_only
  BEFORE UPDATE OR DELETE ON public.commercial_order_cancellations
  FOR EACH ROW EXECUTE FUNCTION public.fn_commercial_evidence_append_only();
CREATE TRIGGER commercial_command_receipts_append_only
  BEFORE UPDATE OR DELETE ON public.commercial_command_receipts
  FOR EACH ROW EXECUTE FUNCTION public.fn_commercial_evidence_append_only();

ALTER TABLE public.commercial_quote_events OWNER TO cerp_app;
ALTER TABLE public.commercial_order_cancellations OWNER TO cerp_app;
ALTER TABLE public.commercial_command_receipts OWNER TO cerp_app;
ALTER FUNCTION public.fn_commercial_evidence_append_only() OWNER TO cerp_app;

REVOKE ALL ON TABLE public.commercial_quote_events FROM PUBLIC, cerp_app;
REVOKE ALL ON TABLE public.commercial_order_cancellations FROM PUBLIC, cerp_app;
REVOKE ALL ON TABLE public.commercial_command_receipts FROM PUBLIC, cerp_app;
GRANT SELECT, INSERT ON TABLE public.commercial_quote_events TO cerp_app;
GRANT SELECT, INSERT ON TABLE public.commercial_order_cancellations TO cerp_app;
GRANT SELECT, INSERT ON TABLE public.commercial_command_receipts TO cerp_app;
REVOKE ALL ON FUNCTION public.fn_commercial_evidence_append_only() FROM PUBLIC, cerp_app;
GRANT EXECUTE ON FUNCTION public.fn_commercial_evidence_append_only() TO cerp_app;

COMMENT ON TABLE public.commercial_quote_events IS
  'SOL-17 append-only quote history. No inferred dates: source and actor make reliability explicit.';
COMMENT ON TABLE public.commercial_order_cancellations IS
  'SOL-17 terminal, audited order cancellations. One immutable cancellation per customer order.';
COMMENT ON TABLE public.commercial_command_receipts IS
  'SOL-17 idempotency receipts. Same action/key/payload replays; a changed payload is rejected.';

COMMIT;
