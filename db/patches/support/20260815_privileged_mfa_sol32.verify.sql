DO $verify$
DECLARE
  invalid bigint;
BEGIN
  IF to_regclass('public.user_mfa_factors') IS NULL
     OR to_regclass('public.user_mfa_recovery_codes') IS NULL
     OR to_regclass('public.auth_mfa_challenges') IS NULL THEN
    RAISE EXCEPTION 'SOL-32 verify: MFA relation is missing';
  END IF;

  SELECT count(*) INTO invalid
    FROM public.user_mfa_factors
   WHERE (state = 'ACTIVE' AND (enrolled_at IS NULL OR revoked_at IS NOT NULL OR pending_expires_at IS NOT NULL))
      OR (state = 'PENDING' AND (pending_expires_at IS NULL OR enrolled_at IS NOT NULL OR revoked_at IS NOT NULL))
      OR octet_length(encryption_iv) <> 12
      OR octet_length(encryption_tag) <> 16;
  IF invalid > 0 THEN RAISE EXCEPTION 'SOL-32 verify: % invalid MFA factor row(s)', invalid; END IF;

  SELECT count(*) INTO invalid FROM (
    SELECT user_id FROM public.user_mfa_factors WHERE state = 'ACTIVE' GROUP BY user_id HAVING count(*) > 1
  ) duplicated;
  IF invalid > 0 THEN RAISE EXCEPTION 'SOL-32 verify: duplicate active factor'; END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app') AND (
    NOT has_table_privilege('cerp_app', 'public.user_mfa_factors', 'SELECT,INSERT,UPDATE')
    OR NOT has_table_privilege('cerp_app', 'public.user_mfa_recovery_codes', 'SELECT,INSERT,UPDATE,DELETE')
    OR NOT has_table_privilege('cerp_app', 'public.auth_mfa_challenges', 'SELECT,INSERT,UPDATE,DELETE')
  ) THEN
    RAISE EXCEPTION 'SOL-32 verify: cerp_app grants are invalid';
  END IF;
END
$verify$;

SELECT current_database() AS database_name,
       (SELECT count(*) FROM public.user_mfa_factors WHERE state = 'ACTIVE') AS active_factors,
       (SELECT count(*) FROM public.user_mfa_factors WHERE state = 'PENDING') AS pending_factors,
       (SELECT count(*) FROM public.user_mfa_recovery_codes WHERE used_at IS NULL) AS unused_recovery_codes,
       now() AS verified_at;
