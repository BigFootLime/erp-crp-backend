-- Guarded rollback for SOL-02 / SEC-CERP-0002. Human approval is mandatory.
-- Application rollback should normally leave this evidence table in place.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.admin_account_invitations') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.admin_account_invitations) THEN
    RAISE EXCEPTION
      'Account invitation evidence exists; disable the routes and preserve the table instead of dropping audit history';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'password_reset_tokens'
      AND column_name = 'created_by'
  ) AND EXISTS (
    SELECT 1 FROM public.password_reset_tokens WHERE created_by IS NOT NULL
  ) THEN
    RAISE EXCEPTION
      'Administrative reset evidence exists; disable the routes and preserve the columns instead of dropping audit history';
  END IF;
END $$;

DROP TABLE IF EXISTS public.admin_account_invitations;
DROP INDEX IF EXISTS public.password_reset_tokens_actor_idempotency_uq;
ALTER TABLE public.password_reset_tokens
  DROP COLUMN IF EXISTS request_hash,
  DROP COLUMN IF EXISTS idempotency_key,
  DROP COLUMN IF EXISTS created_by;

COMMIT;
