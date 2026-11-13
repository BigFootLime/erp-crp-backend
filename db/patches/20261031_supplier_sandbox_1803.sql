-- Local-only supplier sandbox. No-op unless the isolated test runner explicitly enables it.
BEGIN;
DO $$ BEGIN
 IF current_setting('cerp.e2e_isolated',true)='on' THEN
  CREATE TABLE IF NOT EXISTS public.supplier_sandbox_accounts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),supplier_id uuid NOT NULL REFERENCES public.fournisseurs(id) ON DELETE RESTRICT,email_normalized text NOT NULL UNIQUE,password_hash text NOT NULL,status text NOT NULL DEFAULT 'ACTIVE' CHECK(status IN('ACTIVE','DISABLED')),session_epoch integer NOT NULL DEFAULT 0 CHECK(session_epoch>=0),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),CHECK(length(password_hash)>=40));
  CREATE TABLE IF NOT EXISTS public.supplier_sandbox_promise_proposals (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),account_id uuid NOT NULL REFERENCES public.supplier_sandbox_accounts(id) ON DELETE RESTRICT,supplier_id uuid NOT NULL REFERENCES public.fournisseurs(id) ON DELETE RESTRICT,order_id uuid NOT NULL REFERENCES public.commande_fournisseur(id) ON DELETE RESTRICT,line_id uuid NOT NULL REFERENCES public.commande_fournisseur_ligne(id) ON DELETE RESTRICT,promised_date date NOT NULL,promised_quantity numeric(14,3) NOT NULL CHECK(promised_quantity>0),reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 3 AND 1000),status text NOT NULL DEFAULT 'PENDING' CHECK(status IN('PENDING','ACCEPTED','REJECTED')),idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 120),request_hash text NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'),submitted_at timestamptz NOT NULL DEFAULT now(),UNIQUE(account_id,idempotency_key));
  CREATE INDEX IF NOT EXISTS supplier_sandbox_proposals_pending_idx ON public.supplier_sandbox_promise_proposals(status,submitted_at) WHERE status='PENDING';
  ALTER TABLE public.supplier_sandbox_promise_proposals ADD COLUMN IF NOT EXISTS reviewed_at timestamptz, ADD COLUMN IF NOT EXISTS reviewed_by integer REFERENCES public.users(id) ON DELETE SET NULL, ADD COLUMN IF NOT EXISTS review_reason text;
 END IF;
END $$;
COMMIT;
