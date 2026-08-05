-- FEAT-CERP-0002 -- Idempotent, human-governed ADV reminder suggestions.
-- Exact runner-owned migration. It installs no autonomous delivery provider and
-- leaves every policy in DRAFT until an authenticated human validates it.

BEGIN;

DO $preexisting_guard$
BEGIN
  IF to_regclass('public.cerp_schema_migrations') IS NULL THEN
    RAISE EXCEPTION 'FEAT-CERP-0002: migration registry is missing';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.cerp_schema_migrations
    WHERE filename='20260805_adv_reminders.sql'
  ) THEN
    RAISE EXCEPTION 'FEAT-CERP-0002: migration ledger already exists; use the patch runner';
  END IF;
  IF to_regclass('public.facture') IS NULL
     OR to_regclass('public.facture_echeance') IS NULL
     OR to_regclass('public.facture_documents') IS NULL
     OR to_regclass('public.paiement') IS NULL
     OR to_regclass('public.paiement_allocations') IS NULL
     OR to_regclass('public.avoir') IS NULL
     OR to_regclass('public.avoir_source_allocations') IS NULL
     OR to_regclass('public.clients') IS NULL
     OR to_regclass('public.contacts') IS NULL
     OR to_regclass('public.documents_clients') IS NULL
     OR to_regclass('public.users') IS NULL
     OR to_regclass('public.erp_audit_logs') IS NULL
     OR to_regclass('public.app_modules') IS NULL
     OR to_regrole('cerp_app') IS NULL THEN
    RAISE EXCEPTION 'FEAT-CERP-0002: prerequisite table or runtime role is missing';
  END IF;
  IF (SELECT COUNT(*) FROM public.app_modules WHERE module_key='facturation') <> 1 THEN
    RAISE EXCEPTION 'FEAT-CERP-0002: facturation module catalogue entry is missing';
  END IF;
  IF to_regclass('public.adv_reminder_policies') IS NOT NULL
     OR to_regclass('public.adv_reminder_client_preferences') IS NOT NULL
     OR to_regclass('public.adv_reminder_suggestions') IS NOT NULL
     OR to_regclass('public.adv_reminder_events') IS NOT NULL
     OR to_regclass('public.adv_reminder_attempts') IS NOT NULL
     OR to_regclass('public.adv_reminder_command_receipts') IS NOT NULL
     OR to_regprocedure('public.fn_adv_reminder_append_only()') IS NOT NULL
     OR to_regprocedure('public.fn_adv_reminder_cancel_on_finance_change()') IS NOT NULL THEN
    RAISE EXCEPTION 'FEAT-CERP-0002: target artifact exists without ledger provenance';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.app_modules m, unnest(m.api_prefixes) p
    WHERE m.module_key='facturation' AND p='/adv-reminders'
  ) OR EXISTS (
    SELECT 1 FROM public.app_modules m, unnest(m.nav_page_keys) p
    WHERE m.module_key='facturation' AND p='relances'
  ) THEN
    RAISE EXCEPTION 'FEAT-CERP-0002: catalogue target already exists without ledger provenance';
  END IF;
END
$preexisting_guard$;

CREATE TABLE public.adv_reminder_policies (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  version integer NOT NULL,
  row_version integer NOT NULL DEFAULT 1,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'DRAFT',
  timezone text NOT NULL DEFAULT 'Europe/Paris',
  channel text NOT NULL DEFAULT 'EMAIL',
  delivery_mode text NOT NULL DEFAULT 'MANUAL',
  lawful_basis text NOT NULL,
  consent_required boolean NOT NULL DEFAULT false,
  cadence_days smallint[] NOT NULL,
  retry_delays_minutes integer[] NOT NULL DEFAULT ARRAY[5,30,120]::integer[],
  template_subject text NOT NULL,
  template_body text NOT NULL,
  attach_invoice_pdf boolean NOT NULL DEFAULT true,
  validated_at timestamptz,
  validated_by integer,
  retired_at timestamptz,
  retired_by integer,
  retirement_reason text,
  created_by integer NOT NULL,
  updated_by integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT adv_reminder_policies_pkey PRIMARY KEY (id),
  CONSTRAINT adv_reminder_policies_version_uniq UNIQUE (version),
  CONSTRAINT adv_reminder_policies_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE RESTRICT,
  CONSTRAINT adv_reminder_policies_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE RESTRICT,
  CONSTRAINT adv_reminder_policies_validated_by_fkey FOREIGN KEY (validated_by) REFERENCES public.users(id) ON DELETE RESTRICT,
  CONSTRAINT adv_reminder_policies_retired_by_fkey FOREIGN KEY (retired_by) REFERENCES public.users(id) ON DELETE RESTRICT,
  CONSTRAINT adv_reminder_policies_status_ck CHECK (status IN ('DRAFT','VALIDATED','RETIRED')),
  CONSTRAINT adv_reminder_policies_channel_ck CHECK (channel='EMAIL'),
  CONSTRAINT adv_reminder_policies_delivery_ck CHECK (delivery_mode IN ('MANUAL','SANDBOX')),
  CONSTRAINT adv_reminder_policies_basis_ck CHECK (lawful_basis IN ('CONTRACT','LEGITIMATE_INTEREST','CONSENT')),
  CONSTRAINT adv_reminder_policies_values_ck CHECK (
    version>0 AND row_version>0 AND char_length(name) BETWEEN 3 AND 120
    AND char_length(timezone) BETWEEN 3 AND 100
    AND cardinality(cadence_days) BETWEEN 1 AND 12
    AND 0 <= ALL(cadence_days) AND 365 >= ALL(cadence_days)
    AND cardinality(retry_delays_minutes) <= 8
    AND (cardinality(retry_delays_minutes)=0 OR 1 <= ALL(retry_delays_minutes))
    AND char_length(template_subject) BETWEEN 1 AND 200
    AND char_length(template_body) BETWEEN 1 AND 4000
    AND (lawful_basis<>'CONSENT' OR consent_required)
    AND (status<>'VALIDATED' OR (validated_at IS NOT NULL AND validated_by IS NOT NULL))
  )
);
CREATE UNIQUE INDEX adv_reminder_one_validated_policy_uniq
  ON public.adv_reminder_policies ((status)) WHERE status='VALIDATED';

CREATE TABLE public.adv_reminder_client_preferences (
  client_id varchar(3) NOT NULL,
  channel text NOT NULL DEFAULT 'EMAIL',
  recipient_contact_id uuid,
  opted_out boolean NOT NULL DEFAULT false,
  restricted_processing boolean NOT NULL DEFAULT false,
  lawful_basis text NOT NULL,
  consent_granted boolean,
  consent_version text,
  consent_source text,
  consent_recorded_at timestamptz,
  row_version integer NOT NULL DEFAULT 1,
  created_by integer NOT NULL,
  updated_by integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT adv_reminder_client_preferences_pkey PRIMARY KEY (client_id),
  CONSTRAINT adv_reminder_preferences_client_fkey FOREIGN KEY (client_id) REFERENCES public.clients(client_id) ON DELETE RESTRICT,
  CONSTRAINT adv_reminder_preferences_contact_fkey FOREIGN KEY (recipient_contact_id) REFERENCES public.contacts(contact_id) ON DELETE RESTRICT,
  CONSTRAINT adv_reminder_preferences_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE RESTRICT,
  CONSTRAINT adv_reminder_preferences_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE RESTRICT,
  CONSTRAINT adv_reminder_preferences_channel_ck CHECK (channel IN ('EMAIL','NONE')),
  CONSTRAINT adv_reminder_preferences_basis_ck CHECK (lawful_basis IN ('CONTRACT','LEGITIMATE_INTEREST','CONSENT')),
  CONSTRAINT adv_reminder_preferences_consent_ck CHECK (
    row_version>0
    AND (lawful_basis<>'CONSENT' OR consent_granted IS NOT NULL)
    AND ((consent_granted IS NULL AND consent_version IS NULL AND consent_source IS NULL AND consent_recorded_at IS NULL)
      OR (consent_granted IS NOT NULL AND consent_version IS NOT NULL AND consent_source IS NOT NULL AND consent_recorded_at IS NOT NULL))
  )
);

CREATE TABLE public.adv_reminder_suggestions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  facture_id bigint NOT NULL,
  client_id varchar(3) NOT NULL,
  policy_id uuid NOT NULL,
  policy_version integer NOT NULL,
  cadence_step_days smallint NOT NULL,
  due_date date NOT NULL,
  days_overdue integer NOT NULL,
  outstanding_amount numeric(18,2) NOT NULL,
  currency text NOT NULL DEFAULT 'EUR',
  channel text NOT NULL,
  recipient_contact_id uuid,
  recipient_hint text,
  subject_snapshot text NOT NULL,
  body_snapshot text NOT NULL,
  attachment_document_id uuid,
  status text NOT NULL DEFAULT 'SUGGESTED',
  row_version integer NOT NULL DEFAULT 1,
  idempotency_key text NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  claim_token uuid,
  claimed_at timestamptz,
  claimed_by integer,
  approved_at timestamptz,
  approved_by integer,
  sent_at timestamptz,
  provider_message_id text,
  last_error_code text,
  last_error_message text,
  cancelled_at timestamptz,
  cancellation_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT adv_reminder_suggestions_pkey PRIMARY KEY (id),
  CONSTRAINT adv_reminder_suggestions_facture_fkey FOREIGN KEY (facture_id) REFERENCES public.facture(id) ON DELETE RESTRICT,
  CONSTRAINT adv_reminder_suggestions_client_fkey FOREIGN KEY (client_id) REFERENCES public.clients(client_id) ON DELETE RESTRICT,
  CONSTRAINT adv_reminder_suggestions_policy_fkey FOREIGN KEY (policy_id) REFERENCES public.adv_reminder_policies(id) ON DELETE RESTRICT,
  CONSTRAINT adv_reminder_suggestions_contact_fkey FOREIGN KEY (recipient_contact_id) REFERENCES public.contacts(contact_id) ON DELETE RESTRICT,
  CONSTRAINT adv_reminder_suggestions_attachment_fkey FOREIGN KEY (attachment_document_id) REFERENCES public.documents_clients(id) ON DELETE RESTRICT,
  CONSTRAINT adv_reminder_suggestions_claimed_by_fkey FOREIGN KEY (claimed_by) REFERENCES public.users(id) ON DELETE RESTRICT,
  CONSTRAINT adv_reminder_suggestions_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.users(id) ON DELETE RESTRICT,
  CONSTRAINT adv_reminder_suggestions_invoice_cadence_uniq UNIQUE (facture_id,cadence_step_days),
  CONSTRAINT adv_reminder_suggestions_idempotency_uniq UNIQUE (idempotency_key),
  CONSTRAINT adv_reminder_suggestions_status_ck CHECK (status IN (
    'SUGGESTED','BLOCKED','APPROVED','CLAIMED','SENT','FAILED_RETRYABLE','FAILED_FINAL','CANCELLED'
  )),
  CONSTRAINT adv_reminder_suggestions_channel_ck CHECK (channel IN ('EMAIL','NONE')),
  CONSTRAINT adv_reminder_suggestions_values_ck CHECK (
    policy_version>0 AND cadence_step_days BETWEEN 0 AND 365 AND days_overdue>=0
    AND outstanding_amount>0 AND char_length(currency)=3 AND row_version>0 AND attempt_count>=0
    AND idempotency_key ~ '^[0-9a-f]{64}$'
    AND char_length(subject_snapshot) BETWEEN 1 AND 200
    AND char_length(body_snapshot) BETWEEN 1 AND 4000
    AND ((status='CLAIMED')=(claim_token IS NOT NULL AND claimed_at IS NOT NULL))
    AND (status<>'SENT' OR (sent_at IS NOT NULL AND provider_message_id IS NOT NULL))
    AND (status<>'CANCELLED' OR (cancelled_at IS NOT NULL AND cancellation_reason IS NOT NULL))
  )
);
CREATE INDEX adv_reminder_suggestions_queue_idx
  ON public.adv_reminder_suggestions(status,next_attempt_at,created_at)
  WHERE status IN ('APPROVED','FAILED_RETRYABLE','CLAIMED');
CREATE INDEX adv_reminder_suggestions_client_history_idx
  ON public.adv_reminder_suggestions(client_id,created_at DESC);
CREATE INDEX adv_reminder_suggestions_facture_history_idx
  ON public.adv_reminder_suggestions(facture_id,created_at DESC);

CREATE TABLE public.adv_reminder_events (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  suggestion_id uuid NOT NULL,
  event_type text NOT NULL,
  from_status text,
  to_status text NOT NULL,
  actor_user_id integer,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT adv_reminder_events_pkey PRIMARY KEY (id),
  CONSTRAINT adv_reminder_events_suggestion_fkey FOREIGN KEY (suggestion_id) REFERENCES public.adv_reminder_suggestions(id) ON DELETE RESTRICT,
  CONSTRAINT adv_reminder_events_actor_fkey FOREIGN KEY (actor_user_id) REFERENCES public.users(id) ON DELETE RESTRICT,
  CONSTRAINT adv_reminder_events_details_ck CHECK (jsonb_typeof(details)='object')
);
CREATE INDEX adv_reminder_events_suggestion_idx ON public.adv_reminder_events(suggestion_id,created_at DESC);

CREATE TABLE public.adv_reminder_attempts (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  suggestion_id uuid NOT NULL,
  attempt_no integer NOT NULL,
  status text NOT NULL,
  provider text NOT NULL,
  provider_message_id text,
  error_code text,
  retryable boolean NOT NULL DEFAULT false,
  recipient_hash text,
  actor_user_id integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT adv_reminder_attempts_pkey PRIMARY KEY (id),
  CONSTRAINT adv_reminder_attempts_suggestion_fkey FOREIGN KEY (suggestion_id) REFERENCES public.adv_reminder_suggestions(id) ON DELETE RESTRICT,
  CONSTRAINT adv_reminder_attempts_actor_fkey FOREIGN KEY (actor_user_id) REFERENCES public.users(id) ON DELETE RESTRICT,
  CONSTRAINT adv_reminder_attempts_number_uniq UNIQUE (suggestion_id,attempt_no),
  CONSTRAINT adv_reminder_attempts_status_ck CHECK (status IN ('SENT','FAILED')),
  CONSTRAINT adv_reminder_attempts_provider_ck CHECK (provider='sandbox'),
  CONSTRAINT adv_reminder_attempts_values_ck CHECK (
    attempt_no>0 AND (recipient_hash IS NULL OR recipient_hash ~ '^[0-9a-f]{64}$')
    AND (status<>'SENT' OR (provider_message_id IS NOT NULL AND recipient_hash IS NOT NULL))
    AND (status<>'FAILED' OR error_code IS NOT NULL)
  )
);

CREATE TABLE public.adv_reminder_command_receipts (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  actor_user_id integer NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  command_type text NOT NULL,
  policy_id uuid,
  suggestion_id uuid,
  result_payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT adv_reminder_command_receipts_pkey PRIMARY KEY (id),
  CONSTRAINT adv_reminder_receipts_actor_fkey FOREIGN KEY (actor_user_id) REFERENCES public.users(id) ON DELETE RESTRICT,
  CONSTRAINT adv_reminder_receipts_policy_fkey FOREIGN KEY (policy_id) REFERENCES public.adv_reminder_policies(id) ON DELETE RESTRICT,
  CONSTRAINT adv_reminder_receipts_suggestion_fkey FOREIGN KEY (suggestion_id) REFERENCES public.adv_reminder_suggestions(id) ON DELETE RESTRICT,
  CONSTRAINT adv_reminder_receipts_actor_key_uniq UNIQUE (actor_user_id,idempotency_key),
  CONSTRAINT adv_reminder_receipts_values_ck CHECK (
    char_length(idempotency_key) BETWEEN 8 AND 200 AND request_hash ~ '^[0-9a-f]{64}$'
    AND jsonb_typeof(result_payload)='object'
  )
);

CREATE FUNCTION public.fn_adv_reminder_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $append_only$
BEGIN
  RAISE EXCEPTION 'ADV reminder evidence is append-only' USING ERRCODE='55000';
END
$append_only$;

CREATE TRIGGER adv_reminder_events_append_only
BEFORE UPDATE OR DELETE ON public.adv_reminder_events
FOR EACH ROW EXECUTE FUNCTION public.fn_adv_reminder_append_only();
CREATE TRIGGER adv_reminder_attempts_append_only
BEFORE UPDATE OR DELETE ON public.adv_reminder_attempts
FOR EACH ROW EXECUTE FUNCTION public.fn_adv_reminder_append_only();
CREATE TRIGGER adv_reminder_receipts_append_only
BEFORE UPDATE OR DELETE ON public.adv_reminder_command_receipts
FOR EACH ROW EXECUTE FUNCTION public.fn_adv_reminder_append_only();

CREATE FUNCTION public.fn_adv_reminder_cancel_on_finance_change()
RETURNS trigger
LANGUAGE plpgsql
AS $cancel_pending$
DECLARE
  affected_facture_id bigint;
  reason_code text;
  pending record;
BEGIN
  IF TG_TABLE_NAME='facture' THEN
    affected_facture_id := COALESCE(NEW.id,OLD.id);
    reason_code := 'INVOICE_CHANGED';
  ELSIF TG_TABLE_NAME IN ('paiement','paiement_allocations') THEN
    affected_facture_id := COALESCE(NEW.facture_id,OLD.facture_id);
    reason_code := 'PAYMENT_CHANGED';
  ELSE
    affected_facture_id := COALESCE(NEW.facture_id,OLD.facture_id);
    reason_code := 'CREDIT_CHANGED';
  END IF;

  IF affected_facture_id IS NULL THEN
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  FOR pending IN
    SELECT id,status
    FROM public.adv_reminder_suggestions
    WHERE facture_id=affected_facture_id
      AND status IN ('SUGGESTED','BLOCKED','APPROVED','CLAIMED','FAILED_RETRYABLE','FAILED_FINAL')
    ORDER BY id
    FOR UPDATE
  LOOP
    UPDATE public.adv_reminder_suggestions
    SET status='CANCELLED',cancelled_at=statement_timestamp(),cancellation_reason=reason_code,
        claim_token=NULL,claimed_at=NULL,claimed_by=NULL,next_attempt_at=NULL,
        row_version=row_version+1,updated_at=statement_timestamp()
    WHERE id=pending.id;
    INSERT INTO public.adv_reminder_events (
      suggestion_id,event_type,from_status,to_status,details
    ) VALUES (
      pending.id,'SUGGESTION_CANCELLED_BY_FINANCE_CHANGE',pending.status,'CANCELLED',
      jsonb_build_object('reason_code',reason_code,'source_table',TG_TABLE_NAME)
    );
  END LOOP;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$cancel_pending$;

CREATE TRIGGER adv_reminder_cancel_on_facture_change
AFTER UPDATE OF settlement_status,statut,document_status,total_ttc,date_echeance ON public.facture
FOR EACH ROW EXECUTE FUNCTION public.fn_adv_reminder_cancel_on_finance_change();
CREATE TRIGGER adv_reminder_cancel_on_payment_allocation
AFTER INSERT OR UPDATE OR DELETE ON public.paiement_allocations
FOR EACH ROW EXECUTE FUNCTION public.fn_adv_reminder_cancel_on_finance_change();
CREATE TRIGGER adv_reminder_cancel_on_direct_payment
AFTER INSERT OR UPDATE OR DELETE ON public.paiement
FOR EACH ROW EXECUTE FUNCTION public.fn_adv_reminder_cancel_on_finance_change();
CREATE TRIGGER adv_reminder_cancel_on_credit_allocation
AFTER INSERT OR UPDATE OR DELETE ON public.avoir_source_allocations
FOR EACH ROW EXECUTE FUNCTION public.fn_adv_reminder_cancel_on_finance_change();
CREATE TRIGGER adv_reminder_cancel_on_direct_credit
AFTER INSERT OR UPDATE OR DELETE ON public.avoir
FOR EACH ROW EXECUTE FUNCTION public.fn_adv_reminder_cancel_on_finance_change();

UPDATE public.app_modules
SET api_prefixes=array_append(api_prefixes,'/adv-reminders'),
    nav_page_keys=array_append(nav_page_keys,'relances'),
    updated_at=now()
WHERE module_key='facturation'
  AND NOT ('/adv-reminders'=ANY(api_prefixes))
  AND NOT ('relances'=ANY(nav_page_keys));

DO $catalogue_guard$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.app_modules
    WHERE module_key='facturation'
      AND '/adv-reminders'=ANY(api_prefixes)
      AND 'relances'=ANY(nav_page_keys)
  ) THEN
    RAISE EXCEPTION 'FEAT-CERP-0002: facturation catalogue update failed';
  END IF;
END
$catalogue_guard$;

ALTER TABLE public.adv_reminder_policies OWNER TO cerp_app;
ALTER TABLE public.adv_reminder_client_preferences OWNER TO cerp_app;
ALTER TABLE public.adv_reminder_suggestions OWNER TO cerp_app;
ALTER TABLE public.adv_reminder_events OWNER TO cerp_app;
ALTER TABLE public.adv_reminder_attempts OWNER TO cerp_app;
ALTER TABLE public.adv_reminder_command_receipts OWNER TO cerp_app;
ALTER FUNCTION public.fn_adv_reminder_append_only() OWNER TO cerp_app;
ALTER FUNCTION public.fn_adv_reminder_cancel_on_finance_change() OWNER TO cerp_app;

REVOKE ALL ON TABLE public.adv_reminder_policies FROM PUBLIC,cerp_app;
REVOKE ALL ON TABLE public.adv_reminder_client_preferences FROM PUBLIC,cerp_app;
REVOKE ALL ON TABLE public.adv_reminder_suggestions FROM PUBLIC,cerp_app;
REVOKE ALL ON TABLE public.adv_reminder_events FROM PUBLIC,cerp_app;
REVOKE ALL ON TABLE public.adv_reminder_attempts FROM PUBLIC,cerp_app;
REVOKE ALL ON TABLE public.adv_reminder_command_receipts FROM PUBLIC,cerp_app;
GRANT SELECT,INSERT,UPDATE ON TABLE public.adv_reminder_policies TO cerp_app;
GRANT SELECT,INSERT,UPDATE ON TABLE public.adv_reminder_client_preferences TO cerp_app;
GRANT SELECT,INSERT,UPDATE ON TABLE public.adv_reminder_suggestions TO cerp_app;
GRANT SELECT,INSERT ON TABLE public.adv_reminder_events TO cerp_app;
GRANT SELECT,INSERT ON TABLE public.adv_reminder_attempts TO cerp_app;
GRANT SELECT,INSERT ON TABLE public.adv_reminder_command_receipts TO cerp_app;
REVOKE ALL ON FUNCTION public.fn_adv_reminder_append_only() FROM PUBLIC,cerp_app;
REVOKE ALL ON FUNCTION public.fn_adv_reminder_cancel_on_finance_change() FROM PUBLIC,cerp_app;
GRANT EXECUTE ON FUNCTION public.fn_adv_reminder_append_only() TO cerp_app;
GRANT EXECUTE ON FUNCTION public.fn_adv_reminder_cancel_on_finance_change() TO cerp_app;

COMMENT ON TABLE public.adv_reminder_policies IS
  'FEAT-CERP-0002 governed reminder policies. No row is active until explicit authenticated validation.';
COMMENT ON TABLE public.adv_reminder_suggestions IS
  'One immutable cadence identity per invoice; message snapshots exclude recipient email and bank/payment data.';
COMMENT ON TABLE public.adv_reminder_attempts IS
  'Append-only sandbox delivery evidence. Recipient is stored only as a SHA-256 digest.';

COMMIT;
