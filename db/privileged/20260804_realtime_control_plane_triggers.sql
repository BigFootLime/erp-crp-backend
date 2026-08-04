-- Mandatory privileged deployment step for writers outside the application
-- repositories. The normal runner uses cerp_app and intentionally cannot
-- assume ownership of hardened business/audit tables. Deployment automation
-- must run this idempotent file as a superuser after
-- db/patches/20260804_realtime_control_plane_v2.sql and before starting CERP.

\set ON_ERROR_STOP on
BEGIN;

DO $guard$
BEGIN
  IF NOT COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname = current_user), false) THEN
    RAISE EXCEPTION 'realtime control-plane triggers require a superuser (current_user=%)', current_user;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN
    RAISE EXCEPTION 'realtime control-plane trigger owner role postgres is missing';
  END IF;
  IF to_regclass('public.realtime_session_epochs') IS NULL
     OR to_regclass('public.realtime_authorization_epoch') IS NULL
     OR to_regclass('public.realtime_stream_enqueue_state') IS NULL
     OR to_regclass('public.erp_outbox_events') IS NULL
     OR to_regclass('public.erp_audit_logs') IS NULL THEN
    RAISE EXCEPTION 'realtime control-plane trigger prerequisites are missing';
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public.cerp_realtime_bump_session_epoch()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_user_id bigint;
  v_old_user_id bigint;
BEGIN
  IF TG_TABLE_NAME = 'users' THEN
    v_user_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END;
  ELSE
    v_user_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.user_id ELSE NEW.user_id END;
    IF TG_OP = 'UPDATE' AND OLD.user_id IS DISTINCT FROM NEW.user_id THEN
      v_old_user_id := OLD.user_id;
    END IF;
  END IF;

  INSERT INTO public.realtime_session_epochs (user_id, session_epoch, updated_at)
  VALUES (v_user_id, 1, clock_timestamp())
  ON CONFLICT (user_id) DO UPDATE
    SET session_epoch = public.realtime_session_epochs.session_epoch + 1,
        updated_at = clock_timestamp();
  PERFORM pg_notify('cerp_realtime_control', json_build_object('kind', 'session_revoked', 'userId', v_user_id)::text);

  IF v_old_user_id IS NOT NULL THEN
    INSERT INTO public.realtime_session_epochs (user_id, session_epoch, updated_at)
    VALUES (v_old_user_id, 1, clock_timestamp())
    ON CONFLICT (user_id) DO UPDATE
      SET session_epoch = public.realtime_session_epochs.session_epoch + 1,
          updated_at = clock_timestamp();
    PERFORM pg_notify('cerp_realtime_control', json_build_object('kind', 'session_revoked', 'userId', v_old_user_id)::text);
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.cerp_realtime_bump_authorization_epoch()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  UPDATE public.realtime_authorization_epoch
  SET epoch = epoch + 1, updated_at = clock_timestamp()
  WHERE singleton;
  PERFORM pg_notify('cerp_realtime_control', '{"kind":"authorization_changed"}');
  IF TG_LEVEL = 'STATEMENT' THEN RETURN NULL; END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.cerp_realtime_enqueue_audit_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_event_id uuid := gen_random_uuid();
  v_key text := 'audit:new:' || NEW.id::text;
  v_input jsonb;
  v_existing_input jsonb;
  v_stream_ordinal bigint;
BEGIN
  v_input := jsonb_build_object(
    'event', 'audit:new',
    'payload', jsonb_build_object('auditId', NEW.id::text),
    'targets', jsonb_build_array(jsonb_build_object('scope', 'capability', 'capability', 'audit:read')),
    'streamId', 'rt:capability:audit:read',
    'deduplicationKey', v_key
  );

  -- Same global transaction lock as enqueueRealtimeEvent(): transactions that
  -- mix audit and application streams cannot acquire stream state in opposite
  -- orders and deadlock.
  PERFORM pg_advisory_xact_lock(860804120012::bigint);
  SELECT payload -> 'input'
  INTO v_existing_input
  FROM public.erp_outbox_events
  WHERE event_key = 'realtime:' || v_key;
  IF FOUND THEN
    IF v_existing_input <> v_input THEN
      RAISE EXCEPTION 'REALTIME_OUTBOX_KEY_COLLISION';
    END IF;
    RETURN NEW;
  END IF;

  INSERT INTO public.realtime_stream_enqueue_state (stream_id, next_ordinal, updated_at)
  VALUES ('rt:capability:audit:read', 2, clock_timestamp())
  ON CONFLICT (stream_id) DO UPDATE
  SET next_ordinal = public.realtime_stream_enqueue_state.next_ordinal + 1,
      updated_at = clock_timestamp()
  RETURNING next_ordinal - 1 INTO v_stream_ordinal;

  INSERT INTO public.erp_outbox_events (
    event_key, aggregate_type, aggregate_id, event_type, payload,
    correlation_id, status, available_at, realtime_stream_id, realtime_stream_ordinal
  ) VALUES (
    'realtime:' || v_key,
    'REALTIME',
    'rt:capability:audit:read',
    'REALTIME.DISPATCH',
    jsonb_build_object(
      'schemaVersion', 1,
      'eventId', v_event_id::text,
      'input', v_input
    ),
    v_event_id,
    'PENDING',
    now(),
    'rt:capability:audit:read',
    v_stream_ordinal
  );
  RETURN NEW;
END;
$function$;

ALTER FUNCTION public.cerp_realtime_bump_session_epoch() OWNER TO postgres;
ALTER FUNCTION public.cerp_realtime_bump_authorization_epoch() OWNER TO postgres;
ALTER FUNCTION public.cerp_realtime_enqueue_audit_event() OWNER TO postgres;

REVOKE ALL ON FUNCTION public.cerp_realtime_bump_session_epoch() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cerp_realtime_bump_authorization_epoch() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cerp_realtime_enqueue_audit_event() FROM PUBLIC;

-- CREATE OR REPLACE preserves non-PUBLIC grants. Remove every previously
-- granted executor; triggers do not require caller EXECUTE at firing time.
DO $function_acl$
DECLARE
  v_function regprocedure;
  v_grantee text;
BEGIN
  FOREACH v_function IN ARRAY ARRAY[
    'public.cerp_realtime_bump_session_epoch()'::regprocedure,
    'public.cerp_realtime_bump_authorization_epoch()'::regprocedure,
    'public.cerp_realtime_enqueue_audit_event()'::regprocedure
  ] LOOP
    FOR v_grantee IN
      SELECT DISTINCT role.rolname
      FROM pg_proc procedure
      CROSS JOIN LATERAL aclexplode(COALESCE(procedure.proacl, acldefault('f', procedure.proowner))) privilege
      JOIN pg_roles role ON role.oid = privilege.grantee
      WHERE procedure.oid = v_function
        AND privilege.grantee <> procedure.proowner
    LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', v_function, v_grantee);
    END LOOP;
  END LOOP;
END
$function_acl$;

DROP TRIGGER IF EXISTS users_realtime_session_update_trg ON public.users;
CREATE TRIGGER users_realtime_session_update_trg
AFTER UPDATE OF password, role, status, is_superadmin ON public.users
FOR EACH ROW
WHEN (
  OLD.password IS DISTINCT FROM NEW.password OR OLD.role IS DISTINCT FROM NEW.role
  OR OLD.status IS DISTINCT FROM NEW.status OR OLD.is_superadmin IS DISTINCT FROM NEW.is_superadmin
)
EXECUTE FUNCTION public.cerp_realtime_bump_session_epoch();

DROP TRIGGER IF EXISTS users_realtime_session_delete_trg ON public.users;
CREATE TRIGGER users_realtime_session_delete_trg
AFTER DELETE ON public.users FOR EACH ROW
EXECUTE FUNCTION public.cerp_realtime_bump_session_epoch();

DROP TRIGGER IF EXISTS user_role_assignments_realtime_session_trg ON public.user_role_assignments;
CREATE TRIGGER user_role_assignments_realtime_session_trg
AFTER INSERT OR UPDATE OR DELETE ON public.user_role_assignments FOR EACH ROW
EXECUTE FUNCTION public.cerp_realtime_bump_session_epoch();

DROP TRIGGER IF EXISTS users_realtime_authorization_epoch_trg ON public.users;
CREATE TRIGGER users_realtime_authorization_epoch_trg
AFTER UPDATE OF role, status, is_superadmin ON public.users FOR EACH ROW
WHEN (
  OLD.role IS DISTINCT FROM NEW.role OR OLD.status IS DISTINCT FROM NEW.status
  OR OLD.is_superadmin IS DISTINCT FROM NEW.is_superadmin
)
EXECUTE FUNCTION public.cerp_realtime_bump_authorization_epoch();

DROP TRIGGER IF EXISTS app_modules_realtime_authorization_epoch_trg ON public.app_modules;
CREATE TRIGGER app_modules_realtime_authorization_epoch_trg
AFTER INSERT OR UPDATE OR DELETE ON public.app_modules FOR EACH STATEMENT
EXECUTE FUNCTION public.cerp_realtime_bump_authorization_epoch();

DROP TRIGGER IF EXISTS app_module_user_access_realtime_authorization_epoch_trg ON public.app_module_user_access;
CREATE TRIGGER app_module_user_access_realtime_authorization_epoch_trg
AFTER INSERT OR UPDATE OR DELETE ON public.app_module_user_access FOR EACH STATEMENT
EXECUTE FUNCTION public.cerp_realtime_bump_authorization_epoch();

DROP TRIGGER IF EXISTS user_role_assignments_realtime_authorization_epoch_trg ON public.user_role_assignments;
CREATE TRIGGER user_role_assignments_realtime_authorization_epoch_trg
AFTER INSERT OR UPDATE OR DELETE ON public.user_role_assignments FOR EACH STATEMENT
EXECUTE FUNCTION public.cerp_realtime_bump_authorization_epoch();

DROP TRIGGER IF EXISTS erp_audit_logs_realtime_outbox_trg ON public.erp_audit_logs;
CREATE TRIGGER erp_audit_logs_realtime_outbox_trg
AFTER INSERT ON public.erp_audit_logs FOR EACH ROW
EXECUTE FUNCTION public.cerp_realtime_enqueue_audit_event();

COMMIT;
