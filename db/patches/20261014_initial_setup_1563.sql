-- Test signup is disabled unless the process opt-in AND current_database() match.
-- No accounts, legal identities or defaults are created by this patch.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS avatar_key text;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.users'::regclass AND conname='users_avatar_key_1563_ck') THEN
  ALTER TABLE public.users ADD CONSTRAINT users_avatar_key_1563_ck CHECK(avatar_key IS NULL OR avatar_key IN('duck','robot','cat','portrait-1','portrait-2','portrait-3','programmer'));
 END IF;
END $$;
CREATE TABLE IF NOT EXISTS public.test_account_registrations (
 idempotency_key uuid PRIMARY KEY,
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 user_id integer NOT NULL UNIQUE REFERENCES public.users(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.erp_setup_progress (
 user_id integer PRIMARY KEY REFERENCES public.users(id) ON DELETE RESTRICT,
 current_step text NOT NULL CHECK(current_step IN('company','workshop','costs','machines','maintenance','hours','stock','finance','references','review')),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.erp_setup_company_commands (
 idempotency_key uuid PRIMARY KEY,
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 actor_id integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
 biller_id uuid NOT NULL REFERENCES public.factureur(biller_id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT now()
);
-- The API uses its restricted role, not the database owner. Replay ledgers are
-- append-only; only the current onboarding step needs UPDATE permission.
GRANT SELECT,INSERT ON public.test_account_registrations,public.erp_setup_company_commands TO cerp_app;
GRANT SELECT,INSERT,UPDATE ON public.erp_setup_progress TO cerp_app;
COMMIT;
