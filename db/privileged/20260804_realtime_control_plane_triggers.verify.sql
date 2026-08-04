\set ON_ERROR_STOP on
BEGIN TRANSACTION READ ONLY;

DO $verify$
DECLARE
  v_installed integer;
BEGIN
  WITH expected(trigger_name, relation_name, function_name, trigger_type, required_definition) AS (
    VALUES
      ('users_realtime_session_update_trg', 'public.users', 'public.cerp_realtime_bump_session_epoch()', 17, 'UPDATE OF password, role, status, is_superadmin'),
      ('users_realtime_session_delete_trg', 'public.users', 'public.cerp_realtime_bump_session_epoch()', 9, 'AFTER DELETE'),
      ('user_role_assignments_realtime_session_trg', 'public.user_role_assignments', 'public.cerp_realtime_bump_session_epoch()', 29, 'AFTER INSERT OR DELETE OR UPDATE'),
      ('users_realtime_authorization_epoch_trg', 'public.users', 'public.cerp_realtime_bump_authorization_epoch()', 17, 'UPDATE OF role, status, is_superadmin'),
      ('app_modules_realtime_authorization_epoch_trg', 'public.app_modules', 'public.cerp_realtime_bump_authorization_epoch()', 28, 'AFTER INSERT OR DELETE OR UPDATE'),
      ('app_module_user_access_realtime_authorization_epoch_trg', 'public.app_module_user_access', 'public.cerp_realtime_bump_authorization_epoch()', 28, 'AFTER INSERT OR DELETE OR UPDATE'),
      ('user_role_assignments_realtime_authorization_epoch_trg', 'public.user_role_assignments', 'public.cerp_realtime_bump_authorization_epoch()', 28, 'AFTER INSERT OR DELETE OR UPDATE'),
      ('erp_audit_logs_realtime_outbox_trg', 'public.erp_audit_logs', 'public.cerp_realtime_enqueue_audit_event()', 5, 'AFTER INSERT')
  )
  SELECT COUNT(*) FILTER (
    WHERE trigger.oid IS NOT NULL
      AND trigger.tgenabled IN ('O', 'A')
      AND trigger.tgfoid = to_regprocedure(expected.function_name)
      AND trigger.tgtype = expected.trigger_type
      AND position(expected.required_definition IN pg_get_triggerdef(trigger.oid)) > 0
  )::int
  INTO v_installed
  FROM expected
  LEFT JOIN pg_trigger trigger
    ON trigger.tgname = expected.trigger_name
   AND trigger.tgrelid = to_regclass(expected.relation_name)
   AND NOT trigger.tgisinternal;

  IF v_installed <> 8 THEN
    RAISE EXCEPTION 'realtime control-plane trigger backstops incomplete or misconfigured (%/8)', v_installed;
  END IF;
END
$verify$;

DO $functions$
DECLARE
  v_hardened integer;
  v_named integer;
BEGIN
  WITH expected(function_name, normalized_body_md5) AS (
    VALUES
      ('public.cerp_realtime_bump_session_epoch()'::text, 'eaa359d0643f761d7e8715e5a1206c4b'::text),
      ('public.cerp_realtime_bump_authorization_epoch()'::text, '70c4324341adf301e9d3c8764819b641'::text),
    ('public.cerp_realtime_enqueue_audit_event()'::text, 'baf6cd29532fad08842655261bed08c6'::text)
  )
  SELECT COUNT(*) FILTER (
    WHERE procedure.oid IS NOT NULL
      AND procedure.prosecdef
      AND procedure.prokind = 'f'
      AND procedure.provolatile = 'v'
      AND NOT procedure.proisstrict
      AND procedure.pronargs = 0
      AND procedure.prorettype = 'pg_catalog.trigger'::regtype
      AND procedure.prolang = (SELECT oid FROM pg_language WHERE lanname = 'plpgsql')
      AND pg_get_userbyid(procedure.proowner) = 'postgres'
      AND procedure.proconfig = ARRAY['search_path=pg_catalog']::text[]
      AND md5(btrim(regexp_replace(procedure.prosrc, '[[:space:]]+', ' ', 'g'))) = expected.normalized_body_md5
      AND NOT EXISTS (
        SELECT 1
        FROM aclexplode(COALESCE(procedure.proacl, acldefault('f', procedure.proowner))) privilege
        WHERE privilege.grantee <> procedure.proowner
      )
  )::int
  INTO v_hardened
  FROM expected
  LEFT JOIN pg_proc procedure ON procedure.oid = to_regprocedure(expected.function_name);

  SELECT COUNT(*)::int
  INTO v_named
  FROM pg_proc procedure
  JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
  WHERE namespace.nspname = 'public'
    AND procedure.proname = ANY(ARRAY[
      'cerp_realtime_bump_session_epoch',
      'cerp_realtime_bump_authorization_epoch',
      'cerp_realtime_enqueue_audit_event'
    ]::text[]);

  IF v_hardened <> 3 OR v_named <> 3 THEN
    RAISE EXCEPTION 'realtime SECURITY DEFINER functions incomplete or misconfigured (hardened=%/3, named=%/3)',
      v_hardened, v_named;
  END IF;
END
$functions$;

SELECT
  trigger.tgname,
  relation.oid::regclass AS relation_name,
  trigger.tgenabled,
  trigger.tgfoid::regprocedure AS function_name,
  trigger.tgtype,
  pg_get_triggerdef(trigger.oid) AS trigger_definition
FROM pg_trigger trigger
JOIN pg_class relation ON relation.oid = trigger.tgrelid
WHERE trigger.tgname LIKE '%realtime%trg'
ORDER BY trigger.tgname;

SELECT
  procedure.oid::regprocedure AS function_name,
  pg_get_userbyid(procedure.proowner) AS owner_name,
  procedure.prosecdef AS security_definer,
  procedure.proconfig,
  md5(btrim(regexp_replace(procedure.prosrc, '[[:space:]]+', ' ', 'g'))) AS normalized_body_md5,
  procedure.proacl
FROM pg_proc procedure
JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
WHERE namespace.nspname = 'public'
  AND procedure.proname = ANY(ARRAY[
    'cerp_realtime_bump_session_epoch',
    'cerp_realtime_bump_authorization_epoch',
    'cerp_realtime_enqueue_audit_event'
  ]::text[])
ORDER BY procedure.oid::regprocedure::text;

COMMIT;
