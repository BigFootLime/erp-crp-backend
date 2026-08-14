-- SOL-29 — minimal isolated client portal.
-- Additive and safe to replay. Portal identities are deliberately separate
-- from ERP users and every business projection keeps client_id for the
-- mandatory repository-side tenant predicate.

BEGIN;

DO $preconditions$
BEGIN
  IF current_setting('server_version_num')::integer < 140000 THEN
    RAISE EXCEPTION 'SOL-29 requires PostgreSQL 14 or newer';
  END IF;
  IF to_regclass('public.clients') IS NULL
     OR to_regclass('public.users') IS NULL
     OR to_regclass('public.commande_client') IS NULL
     OR to_regclass('public.commande_historique') IS NULL
     OR to_regclass('public.bon_livraison') IS NULL
     OR to_regclass('public.facture') IS NULL
     OR to_regclass('public.ged_documents') IS NULL
     OR to_regclass('public.ged_document_versions') IS NULL
     OR to_regclass('public.ged_upload_sessions') IS NULL THEN
    RAISE EXCEPTION 'SOL-29 prerequisite relation is missing';
  END IF;
END
$preconditions$;

CREATE TABLE IF NOT EXISTS public.client_portal_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id varchar(3) NOT NULL REFERENCES public.clients(client_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  email text NOT NULL,
  email_normalized text NOT NULL,
  display_name text NOT NULL,
  password_hash text NOT NULL,
  status text NOT NULL DEFAULT 'INVITED',
  session_epoch integer NOT NULL DEFAULT 0,
  activated_at timestamptz NULL,
  last_login_at timestamptz NULL,
  suspended_at timestamptz NULL,
  revoked_at timestamptz NULL,
  created_by integer NOT NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  updated_by integer NOT NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT client_portal_account_email_ck CHECK (
    email_normalized = lower(btrim(email_normalized))
    AND char_length(email_normalized) BETWEEN 3 AND 254
    AND char_length(email) BETWEEN 3 AND 254
  ),
  CONSTRAINT client_portal_account_name_ck CHECK (char_length(btrim(display_name)) BETWEEN 2 AND 120),
  CONSTRAINT client_portal_account_password_ck CHECK (char_length(password_hash) BETWEEN 40 AND 255),
  CONSTRAINT client_portal_account_status_ck CHECK (status IN ('INVITED','ACTIVE','SUSPENDED','REVOKED')),
  CONSTRAINT client_portal_account_epoch_ck CHECK (session_epoch >= 0),
  CONSTRAINT client_portal_account_lifecycle_ck CHECK (
    (status = 'ACTIVE' AND activated_at IS NOT NULL AND suspended_at IS NULL AND revoked_at IS NULL)
    OR (status = 'INVITED' AND activated_at IS NULL AND suspended_at IS NULL AND revoked_at IS NULL)
    OR (status = 'SUSPENDED' AND activated_at IS NOT NULL AND suspended_at IS NOT NULL AND revoked_at IS NULL)
    OR (status = 'REVOKED' AND revoked_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS client_portal_accounts_email_active_uq
  ON public.client_portal_accounts(email_normalized)
  WHERE status <> 'REVOKED';
CREATE INDEX IF NOT EXISTS client_portal_accounts_client_idx
  ON public.client_portal_accounts(client_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS public.client_portal_tokens (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES public.client_portal_accounts(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  purpose text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz NULL,
  revoked_at timestamptz NULL,
  created_by integer NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT client_portal_token_purpose_ck CHECK (purpose IN ('INVITATION','PASSWORD_RESET')),
  CONSTRAINT client_portal_token_hash_ck CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT client_portal_token_expiry_ck CHECK (expires_at > created_at),
  CONSTRAINT client_portal_token_lifecycle_ck CHECK (consumed_at IS NULL OR revoked_at IS NULL)
);

CREATE INDEX IF NOT EXISTS client_portal_tokens_active_idx
  ON public.client_portal_tokens(account_id, purpose, expires_at DESC)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS public.client_portal_command_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  erp_actor_id integer NOT NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  action text NOT NULL,
  idempotency_key uuid NOT NULL,
  request_sha256 text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT client_portal_receipt_action_ck CHECK (char_length(action) BETWEEN 2 AND 80),
  CONSTRAINT client_portal_receipt_hash_ck CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT client_portal_receipt_result_ck CHECK (jsonb_typeof(result) = 'object'),
  CONSTRAINT client_portal_receipt_uq UNIQUE (erp_actor_id, action, idempotency_key)
);

CREATE TABLE IF NOT EXISTS public.client_portal_publications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id varchar(3) NOT NULL REFERENCES public.clients(client_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  version_id uuid NOT NULL REFERENCES public.ged_document_versions(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  title_override text NULL,
  acknowledgement_required boolean NOT NULL DEFAULT false,
  expires_at timestamptz NULL,
  revoked_at timestamptz NULL,
  revoked_reason text NULL,
  published_by integer NOT NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  revoked_by integer NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT client_portal_publication_title_ck CHECK (
    title_override IS NULL OR char_length(btrim(title_override)) BETWEEN 2 AND 180
  ),
  CONSTRAINT client_portal_publication_expiry_ck CHECK (expires_at IS NULL OR expires_at > created_at),
  CONSTRAINT client_portal_publication_revocation_ck CHECK (
    (revoked_at IS NULL AND revoked_by IS NULL AND revoked_reason IS NULL)
    OR (revoked_at IS NOT NULL AND revoked_by IS NOT NULL AND char_length(btrim(revoked_reason)) BETWEEN 3 AND 500)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS client_portal_publications_active_uq
  ON public.client_portal_publications(client_id, version_id)
  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS client_portal_publications_client_idx
  ON public.client_portal_publications(client_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.client_portal_acknowledgements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  publication_id uuid NOT NULL REFERENCES public.client_portal_publications(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  account_id uuid NOT NULL REFERENCES public.client_portal_accounts(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  acknowledged_at timestamptz NOT NULL DEFAULT now(),
  request_id text NULL,
  CONSTRAINT client_portal_ack_request_ck CHECK (request_id IS NULL OR char_length(request_id) <= 160),
  CONSTRAINT client_portal_ack_uq UNIQUE (publication_id, account_id)
);

CREATE OR REPLACE FUNCTION public.fn_client_portal_ack_tenant_guard_sol29()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  account_client_id varchar(3);
  publication_client_id varchar(3);
BEGIN
  SELECT client_id INTO account_client_id
    FROM public.client_portal_accounts
   WHERE id = NEW.account_id;
  SELECT client_id INTO publication_client_id
    FROM public.client_portal_publications
   WHERE id = NEW.publication_id;
  IF account_client_id IS NULL
     OR publication_client_id IS NULL
     OR account_client_id <> publication_client_id THEN
    RAISE EXCEPTION 'SOL-29 cross-client acknowledgement refused' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_client_portal_ack_tenant_guard_sol29 ON public.client_portal_acknowledgements;
CREATE TRIGGER trg_client_portal_ack_tenant_guard_sol29
BEFORE INSERT ON public.client_portal_acknowledgements
FOR EACH ROW EXECUTE FUNCTION public.fn_client_portal_ack_tenant_guard_sol29();

CREATE TABLE IF NOT EXISTS public.client_portal_audit_events (
  id bigserial PRIMARY KEY,
  erp_actor_id integer NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE SET NULL,
  portal_account_id uuid NULL REFERENCES public.client_portal_accounts(id) ON UPDATE RESTRICT ON DELETE SET NULL,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  client_id varchar(3) NULL REFERENCES public.clients(client_id) ON UPDATE RESTRICT ON DELETE SET NULL,
  request_id text NULL,
  ip_hash text NULL,
  user_agent_family text NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT client_portal_audit_actor_ck CHECK (num_nonnulls(erp_actor_id, portal_account_id) <= 1),
  CONSTRAINT client_portal_audit_action_ck CHECK (char_length(action) BETWEEN 2 AND 120),
  CONSTRAINT client_portal_audit_entity_ck CHECK (
    char_length(entity_type) BETWEEN 2 AND 80 AND char_length(entity_id) BETWEEN 1 AND 160
  ),
  CONSTRAINT client_portal_audit_request_ck CHECK (request_id IS NULL OR char_length(request_id) <= 160),
  CONSTRAINT client_portal_audit_ip_ck CHECK (ip_hash IS NULL OR ip_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT client_portal_audit_ua_ck CHECK (user_agent_family IS NULL OR char_length(user_agent_family) <= 80),
  CONSTRAINT client_portal_audit_details_ck CHECK (
    jsonb_typeof(details) = 'object' AND octet_length(details::text) <= 32768
  )
);

CREATE INDEX IF NOT EXISTS client_portal_audit_client_idx
  ON public.client_portal_audit_events(client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS client_portal_audit_account_idx
  ON public.client_portal_audit_events(portal_account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.client_portal_auth_attempts (
  id bigserial PRIMARY KEY,
  action text NOT NULL,
  identifier_hash text NOT NULL,
  ip_hash text NULL,
  success boolean NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT client_portal_auth_attempt_action_ck CHECK (action IN ('LOGIN','ACTIVATE','FORGOT_PASSWORD','RESET_PASSWORD')),
  CONSTRAINT client_portal_auth_attempt_identifier_ck CHECK (identifier_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT client_portal_auth_attempt_ip_ck CHECK (ip_hash IS NULL OR ip_hash ~ '^[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS client_portal_auth_attempts_lookup_idx
  ON public.client_portal_auth_attempts(action, identifier_hash, occurred_at DESC);
CREATE INDEX IF NOT EXISTS client_portal_auth_attempts_ip_idx
  ON public.client_portal_auth_attempts(action, ip_hash, occurred_at DESC)
  WHERE ip_hash IS NOT NULL;

CREATE OR REPLACE FUNCTION public.fn_client_portal_evidence_immutable_sol29()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'SOL-29 client portal evidence is immutable' USING ERRCODE = '55000';
END;
$function$;

DROP TRIGGER IF EXISTS trg_client_portal_receipts_immutable_sol29 ON public.client_portal_command_receipts;
CREATE TRIGGER trg_client_portal_receipts_immutable_sol29
BEFORE UPDATE OR DELETE ON public.client_portal_command_receipts
FOR EACH ROW EXECUTE FUNCTION public.fn_client_portal_evidence_immutable_sol29();

DROP TRIGGER IF EXISTS trg_client_portal_ack_immutable_sol29 ON public.client_portal_acknowledgements;
CREATE TRIGGER trg_client_portal_ack_immutable_sol29
BEFORE UPDATE OR DELETE ON public.client_portal_acknowledgements
FOR EACH ROW EXECUTE FUNCTION public.fn_client_portal_evidence_immutable_sol29();

DROP TRIGGER IF EXISTS trg_client_portal_audit_immutable_sol29 ON public.client_portal_audit_events;
CREATE TRIGGER trg_client_portal_audit_immutable_sol29
BEFORE UPDATE OR DELETE ON public.client_portal_audit_events
FOR EACH ROW EXECUTE FUNCTION public.fn_client_portal_evidence_immutable_sol29();

CREATE OR REPLACE VIEW public.client_portal_orders_v
WITH (security_barrier = true)
AS
SELECT
  cc.client_id,
  cc.id::text AS id,
  cc.numero,
  cc.date_commande::text AS date_commande,
  COALESCE(st.nouveau_statut, 'BROUILLON')::text AS statut,
  cc.total_ht::float8 AS total_ht,
  cc.total_ttc::float8 AS total_ttc,
  NULLIF(btrim(to_jsonb(c)->>'devise'), '') AS currency,
  cc.updated_at::text AS updated_at
FROM public.commande_client cc
JOIN public.clients c ON c.client_id = cc.client_id
LEFT JOIN LATERAL (
  SELECT COALESCE(
           NULLIF(to_jsonb(ch)->>'nouveau_statut', ''),
           NULLIF((to_jsonb(ch)->'details')->>'nouveau_statut', ''),
           NULLIF((to_jsonb(ch)->'details')->>'to', '')
         ) AS nouveau_statut
  FROM public.commande_historique ch
  WHERE ch.commande_id = cc.id
  ORDER BY ch.date_action DESC, ch.id DESC
  LIMIT 1
) st ON true
WHERE upper(COALESCE(st.nouveau_statut, 'BROUILLON')) <> 'BROUILLON';

CREATE OR REPLACE VIEW public.client_portal_deliveries_v
WITH (security_barrier = true)
AS
SELECT
  bl.client_id,
  bl.id::text AS id,
  bl.numero,
  bl.statut::text AS statut,
  bl.commande_id::text AS commande_id,
  cc.numero AS commande_numero,
  bl.date_creation::text AS date_creation,
  bl.date_expedition::text AS date_expedition,
  bl.date_livraison::text AS date_livraison,
  bl.transporteur,
  bl.tracking_number,
  bl.updated_at::text AS updated_at
FROM public.bon_livraison bl
LEFT JOIN public.commande_client cc ON cc.id = bl.commande_id
WHERE upper(bl.statut::text) <> 'DRAFT';

CREATE OR REPLACE VIEW public.client_portal_invoices_v
WITH (security_barrier = true)
AS
SELECT
  f.client_id,
  f.id::text AS id,
  f.numero,
  f.commande_id::text AS commande_id,
  f.date_emission::text AS date_emission,
  f.date_echeance::text AS date_echeance,
  f.statut::text AS statut,
  f.document_status::text AS document_status,
  f.settlement_status::text AS settlement_status,
  f.total_ht::float8 AS total_ht,
  f.total_ttc::float8 AS total_ttc,
  NULLIF(btrim(to_jsonb(c)->>'devise'), '') AS currency,
  f.updated_at::text AS updated_at
FROM public.facture f
JOIN public.clients c ON c.client_id = f.client_id
WHERE upper(COALESCE(f.document_status::text, f.statut::text, 'DRAFT')) NOT IN ('DRAFT','BROUILLON');

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app') THEN
    GRANT SELECT, INSERT, UPDATE ON public.client_portal_accounts TO cerp_app;
    GRANT SELECT, INSERT, UPDATE ON public.client_portal_tokens TO cerp_app;
    GRANT SELECT, INSERT ON public.client_portal_command_receipts TO cerp_app;
    GRANT SELECT, INSERT, UPDATE ON public.client_portal_publications TO cerp_app;
    GRANT SELECT, INSERT ON public.client_portal_acknowledgements TO cerp_app;
    GRANT SELECT, INSERT ON public.client_portal_audit_events TO cerp_app;
    GRANT SELECT, INSERT, DELETE ON public.client_portal_auth_attempts TO cerp_app;
    GRANT SELECT ON public.client_portal_orders_v TO cerp_app;
    GRANT SELECT ON public.client_portal_deliveries_v TO cerp_app;
    GRANT SELECT ON public.client_portal_invoices_v TO cerp_app;
    GRANT USAGE, SELECT ON SEQUENCE public.client_portal_audit_events_id_seq TO cerp_app;
    GRANT USAGE, SELECT ON SEQUENCE public.client_portal_auth_attempts_id_seq TO cerp_app;
  END IF;
END
$grants$;

COMMIT;
