\set ON_ERROR_STOP on

BEGIN TRANSACTION READ ONLY;

DO $verify$
BEGIN
  IF NOT has_table_privilege('cerp_app', 'public.client_portal_auth_attempts', 'UPDATE') THEN
    RAISE EXCEPTION 'CERP-AUDIT-004 verify: cerp_app cannot mark portal authentication attempts successful';
  END IF;
END
$verify$;

SELECT has_table_privilege('cerp_app', 'public.client_portal_auth_attempts', 'UPDATE')
  AS can_mark_portal_auth_attempt_success;

COMMIT;
