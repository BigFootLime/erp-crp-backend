\set ON_ERROR_STOP on

BEGIN TRANSACTION READ ONLY;

DO $verify$
BEGIN
  IF NOT has_table_privilege('cerp_app', 'public.user_mfa_factors', 'DELETE') THEN
    RAISE EXCEPTION 'CERP-REPAIR-00 MFA cleanup verify: cerp_app cannot delete expired pending MFA factors';
  END IF;
END
$verify$;

SELECT has_table_privilege('cerp_app', 'public.user_mfa_factors', 'DELETE')
         AS can_delete_expired_pending_factors,
       now() AS verified_at;

COMMIT;
