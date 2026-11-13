-- Dormant supplier portal schema. Runtime remains closed until the approved pilot gate is proven.
BEGIN;
CREATE TABLE IF NOT EXISTS public.supplier_portal_configuration(
 id boolean PRIMARY KEY DEFAULT true CHECK(id), enabled boolean NOT NULL DEFAULT false,
 pilot_supplier_id uuid REFERENCES public.fournisseurs(id) ON DELETE RESTRICT,
 evidence_order_ids uuid[] NOT NULL DEFAULT '{}', purchasing_owner_user_id integer REFERENCES public.users(id),
 support_owner_user_id integer REFERENCES public.users(id), administrator_user_ids integer[] NOT NULL DEFAULT '{}', approved_policy_version text,
 consent_and_export_controlled boolean NOT NULL DEFAULT false, dedicated_secret_configured boolean NOT NULL DEFAULT false,
 approved_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(NOT enabled OR (pilot_supplier_id IS NOT NULL AND cardinality(evidence_order_ids)>=2 AND purchasing_owner_user_id IS NOT NULL
   AND support_owner_user_id IS NOT NULL AND cardinality(administrator_user_ids)>=1 AND approved_policy_version IS NOT NULL AND consent_and_export_controlled AND dedicated_secret_configured AND approved_at IS NOT NULL))
);
ALTER TABLE public.supplier_portal_configuration ADD COLUMN IF NOT EXISTS administrator_user_ids integer[] NOT NULL DEFAULT '{}';
INSERT INTO public.supplier_portal_configuration(id) VALUES(true) ON CONFLICT(id) DO NOTHING;
CREATE TABLE IF NOT EXISTS public.supplier_portal_accounts(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),supplier_id uuid NOT NULL REFERENCES public.fournisseurs(id) ON DELETE RESTRICT,
 email_normalized text NOT NULL UNIQUE,password_hash text,account_status text NOT NULL DEFAULT 'INVITED'
  CHECK(account_status IN('INVITED','ACTIVE','DISABLED')),session_epoch integer NOT NULL DEFAULT 0,
 consented_at timestamptz,policy_version text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(password_hash IS NULL OR length(password_hash)>=40)
);
CREATE TABLE IF NOT EXISTS public.supplier_portal_account_orders(
 account_id uuid NOT NULL REFERENCES public.supplier_portal_accounts(id) ON DELETE CASCADE,
 order_id uuid NOT NULL REFERENCES public.commande_fournisseur(id) ON DELETE RESTRICT, PRIMARY KEY(account_id,order_id)
);
CREATE TABLE IF NOT EXISTS public.supplier_portal_tokens(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),account_id uuid NOT NULL REFERENCES public.supplier_portal_accounts(id) ON DELETE CASCADE,
 token_kind text NOT NULL CHECK(token_kind IN('ACTIVATE','RESET')),token_hash text NOT NULL UNIQUE,
 expires_at timestamptz NOT NULL,used_at timestamptz,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS supplier_portal_tokens_live_idx ON public.supplier_portal_tokens(account_id,token_kind,expires_at) WHERE used_at IS NULL;
CREATE TABLE IF NOT EXISTS public.supplier_portal_promise_reviews(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),account_id uuid NOT NULL REFERENCES public.supplier_portal_accounts(id) ON DELETE RESTRICT,
 supplier_id uuid NOT NULL REFERENCES public.fournisseurs(id) ON DELETE RESTRICT,order_id uuid NOT NULL REFERENCES public.commande_fournisseur(id) ON DELETE RESTRICT,
 line_id uuid NOT NULL REFERENCES public.commande_fournisseur_ligne(id) ON DELETE RESTRICT,
 promise_date date NOT NULL,promise_quantity numeric(14,3) NOT NULL CHECK(promise_quantity>0),reason text NOT NULL,
 source_version text NOT NULL,idempotency_key text NOT NULL,request_hash text NOT NULL,
 status text NOT NULL DEFAULT 'PENDING' CHECK(status IN('PENDING','ACCEPTED','REJECTED')),
 decision_note text,reviewed_by integer REFERENCES public.users(id) ON DELETE SET NULL,reviewed_at timestamptz,
 submitted_at timestamptz NOT NULL DEFAULT now(),UNIQUE(account_id,idempotency_key)
);
CREATE INDEX IF NOT EXISTS supplier_portal_reviews_pending_idx ON public.supplier_portal_promise_reviews(status,submitted_at) WHERE status='PENDING';
ALTER TABLE public.supplier_portal_promise_reviews ADD COLUMN IF NOT EXISTS decision_idempotency_key text,
 ADD COLUMN IF NOT EXISTS decision_hash text,
 ADD COLUMN IF NOT EXISTS estimated_treatment_return_date date,
 ADD COLUMN IF NOT EXISTS estimate_reason text;
CREATE TABLE IF NOT EXISTS public.supplier_internal_treatment_estimates(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),supplier_id uuid NOT NULL REFERENCES public.fournisseurs(id) ON DELETE RESTRICT,
 order_id uuid NOT NULL REFERENCES public.commande_fournisseur(id) ON DELETE RESTRICT,line_id uuid NOT NULL UNIQUE REFERENCES public.commande_fournisseur_ligne(id) ON DELETE RESTRICT,
 estimated_return_date date NOT NULL,reason text NOT NULL,source_version text NOT NULL,created_by integer NOT NULL REFERENCES public.users(id),
 updated_at timestamptz NOT NULL DEFAULT now(),status text NOT NULL DEFAULT 'ESTIMATED' CHECK(status='ESTIMATED')
);
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='cerp_app') THEN
 GRANT SELECT,INSERT,UPDATE ON public.supplier_portal_configuration,public.supplier_portal_accounts,public.supplier_portal_account_orders,public.supplier_portal_tokens,public.supplier_portal_promise_reviews,public.supplier_internal_treatment_estimates TO cerp_app;
END IF; END $$;
COMMIT;
