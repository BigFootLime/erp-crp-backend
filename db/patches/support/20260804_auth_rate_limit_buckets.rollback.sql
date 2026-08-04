\set ON_ERROR_STOP on

-- Destructive rollback is deliberately restricted to cerp_test. Production
-- rollback reverts the application release and leaves the inert table in place.
DO $guard$
BEGIN
  IF current_database() <> 'cerp_test' THEN
    RAISE EXCEPTION 'SEC-CERP-0005 rollback is restricted to cerp_test';
  END IF;
END
$guard$;

BEGIN;
DROP TABLE IF EXISTS public.auth_rate_limit_buckets;
COMMIT;
