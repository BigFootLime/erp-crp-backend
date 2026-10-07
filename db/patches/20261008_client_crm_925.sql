BEGIN;
SET LOCAL lock_timeout='5s';
DO $$ BEGIN
  IF to_regclass('public.clients') IS NULL OR to_regclass('public.contacts') IS NULL
     OR to_regclass('public.users') IS NULL OR to_regclass('public.erp_audit_logs') IS NULL THEN
    RAISE EXCEPTION 'CRM requires the canonical client, contact, user and audit schemas';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.client_crm_profiles (
  client_id varchar PRIMARY KEY REFERENCES public.clients(client_id) ON DELETE RESTRICT,
  customer_kind text NOT NULL DEFAULT 'UNSPECIFIED' CHECK(customer_kind IN('UNSPECIFIED','PROFESSIONAL','INDIVIDUAL')),
  stage text NOT NULL DEFAULT 'TO_QUALIFY' CHECK(stage IN('TO_QUALIFY','CONTACTED','QUALIFIED','QUOTE_SENT','NEGOTIATION','WON','LOST','ON_HOLD')),
  owner_user_id integer REFERENCES public.users(id) ON DELETE RESTRICT,
  contact_policy text NOT NULL DEFAULT 'NOT_REVIEWED' CHECK(contact_policy IN('NOT_REVIEWED','ALLOWED','EMAIL_OPTOUT','DO_NOT_CONTACT')),
  retention_review_date date,
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS public.client_crm_followups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id varchar NOT NULL REFERENCES public.clients(client_id) ON DELETE RESTRICT,
  contact_id uuid REFERENCES public.contacts(contact_id) ON DELETE RESTRICT,
  owner_user_id integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  channel text NOT NULL CHECK(channel IN('PHONE','EMAIL','MEETING','INTERNAL')),
  purpose text NOT NULL CHECK(purpose IN('INITIAL_CONTACT','QUOTE_FOLLOW_UP','ORDER_FOLLOW_UP','OTHER')),
  title text CHECK(title IS NULL OR length(btrim(title)) BETWEEN 3 AND 160),
  due_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'PLANNED' CHECK(status IN('PLANNED','COMPLETED','CANCELLED')),
  outcome text CHECK(outcome IN('CONTACTED','NO_ANSWER','INTERESTED','NOT_INTERESTED','QUOTE_REQUESTED','OTHER')),
  result_note text CHECK(result_note IS NULL OR length(result_note)<=2000),
  completed_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  CHECK(purpose<>'OTHER' OR title IS NOT NULL),
  CHECK((status='PLANNED' AND completed_at IS NULL AND outcome IS NULL AND result_note IS NULL)
    OR (status='COMPLETED' AND completed_at IS NOT NULL AND outcome IS NOT NULL)
    OR (status='CANCELLED' AND completed_at IS NOT NULL AND outcome IS NULL AND result_note IS NOT NULL AND length(btrim(result_note))>=3)),
  UNIQUE(id,client_id)
);
CREATE INDEX IF NOT EXISTS client_crm_followups_due_idx ON public.client_crm_followups(due_at,id) WHERE status='PLANNED';
CREATE INDEX IF NOT EXISTS client_crm_followups_client_idx ON public.client_crm_followups(client_id,status,due_at,id);
CREATE INDEX IF NOT EXISTS client_crm_followups_owner_idx ON public.client_crm_followups(owner_user_id,due_at,id) WHERE status='PLANNED';
CREATE TABLE IF NOT EXISTS public.client_crm_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id varchar NOT NULL REFERENCES public.clients(client_id) ON DELETE RESTRICT,
  followup_id uuid,
  action text NOT NULL CHECK(action IN('QUALIFY','PLAN','RESCHEDULE','COMPLETE','CANCEL','LOG_INTERACTION')),
  actor_user_id integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  idempotency_key uuid NOT NULL,
  request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  details jsonb NOT NULL,
  response_json jsonb NOT NULL,
  UNIQUE(actor_user_id,idempotency_key),
  FOREIGN KEY(followup_id,client_id) REFERENCES public.client_crm_followups(id,client_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS client_crm_events_client_idx ON public.client_crm_events(client_id,occurred_at DESC,id DESC);
CREATE OR REPLACE FUNCTION public.cerp_guard_crm_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION 'CRM history is append-only';
END $$;
DROP TRIGGER IF EXISTS client_crm_events_guard ON public.client_crm_events;
CREATE TRIGGER client_crm_events_guard BEFORE UPDATE OR DELETE ON public.client_crm_events
  FOR EACH ROW EXECUTE FUNCTION public.cerp_guard_crm_event();
GRANT SELECT,INSERT,UPDATE ON public.client_crm_profiles, public.client_crm_followups TO cerp_app;
GRANT SELECT,INSERT ON public.client_crm_events TO cerp_app;
REVOKE DELETE,TRUNCATE ON public.client_crm_profiles, public.client_crm_followups FROM cerp_app;
REVOKE UPDATE,DELETE,TRUNCATE ON public.client_crm_events FROM cerp_app;
COMMIT;
