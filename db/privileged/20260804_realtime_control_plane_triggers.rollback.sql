\set ON_ERROR_STOP on
BEGIN;

DO $guard$
DECLARE
  v_inherited_v1 boolean;
  v_recorded_at timestamptz;
  v_baseline_event_count bigint;
  v_baseline_event_min bigint;
  v_baseline_event_max bigint;
  v_initial_last_sequence bigint;
  v_initial_pruned_through bigint;
  v_current_event_count bigint;
  v_current_event_min bigint;
  v_current_event_max bigint;
  v_last_sequence bigint;
  v_pruned_through bigint;
BEGIN
  IF NOT COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname = current_user), false) THEN
    RAISE EXCEPTION 'realtime trigger rollback requires a superuser (current_user=%)', current_user;
  END IF;
  IF current_database() <> 'cerp_test' THEN
    RAISE EXCEPTION 'realtime trigger rollback restricted to cerp_test (current=%)', current_database();
  END IF;
  IF to_regclass('public.realtime_control_plane_v2_provenance') IS NULL
     OR (SELECT COUNT(*) FROM public.realtime_control_plane_v2_provenance WHERE singleton) <> 1 THEN
    RAISE EXCEPTION 'realtime trigger rollback refused: v2 provenance is missing';
  END IF;

  SELECT inherited_v1, recorded_at, baseline_event_count, baseline_event_min,
         baseline_event_max, initial_last_sequence, initial_pruned_through
  INTO v_inherited_v1, v_recorded_at, v_baseline_event_count, v_baseline_event_min,
       v_baseline_event_max, v_initial_last_sequence, v_initial_pruned_through
  FROM public.realtime_control_plane_v2_provenance
  WHERE singleton;
  SELECT COUNT(*)::bigint, MIN(sequence), MAX(sequence)
  INTO v_current_event_count, v_current_event_min, v_current_event_max
  FROM public.realtime_event_log;
  SELECT last_sequence, pruned_through
  INTO v_last_sequence, v_pruned_through
  FROM public.realtime_event_sequence_state
  WHERE singleton;

  -- Every refusal condition is checked before the first DROP/CREATE below.
  -- This makes a failed split rollback observationally atomic.
  IF v_current_event_count IS DISTINCT FROM v_baseline_event_count
     OR v_current_event_min IS DISTINCT FROM v_baseline_event_min
     OR v_current_event_max IS DISTINCT FROM v_baseline_event_max
     OR v_last_sequence IS DISTINCT FROM v_initial_last_sequence
     OR v_pruned_through IS DISTINCT FROM v_initial_pruned_through
     OR COALESCE((SELECT epoch FROM public.realtime_authorization_epoch WHERE singleton), -1) <> 0
     OR EXISTS (SELECT 1 FROM public.realtime_chat_presence)
     OR EXISTS (SELECT 1 FROM public.realtime_stream_enqueue_state)
     OR EXISTS (SELECT 1 FROM public.realtime_event_quarantine)
     OR EXISTS (
       SELECT 1 FROM public.erp_outbox_events
       WHERE aggregate_type = 'REALTIME' OR event_type = 'REALTIME.DISPATCH'
          OR realtime_stream_id IS NOT NULL OR realtime_stream_ordinal IS NOT NULL
     )
     OR EXISTS (
       SELECT 1 FROM public.realtime_session_epochs
       WHERE updated_at >= v_recorded_at
     )
     OR (NOT v_inherited_v1 AND EXISTS (SELECT 1 FROM public.realtime_session_epochs)) THEN
    RAISE EXCEPTION 'realtime trigger rollback refused: v2 control-plane usage detected; no object was changed';
  END IF;
END
$guard$;

-- Remove only v2-only backstops first.
DROP TRIGGER IF EXISTS erp_audit_logs_realtime_outbox_trg ON public.erp_audit_logs;
DROP TRIGGER IF EXISTS user_role_assignments_realtime_authorization_epoch_trg ON public.user_role_assignments;
DROP TRIGGER IF EXISTS app_module_user_access_realtime_authorization_epoch_trg ON public.app_module_user_access;
DROP TRIGGER IF EXISTS app_modules_realtime_authorization_epoch_trg ON public.app_modules;
DROP TRIGGER IF EXISTS users_realtime_authorization_epoch_trg ON public.users;

DROP FUNCTION IF EXISTS public.cerp_realtime_enqueue_audit_event();
DROP FUNCTION IF EXISTS public.cerp_realtime_bump_authorization_epoch();

-- Recreate the three session backstops with the exact v1 behavior. The clean
-- v2 branch removes them again below; the inherited-v1 branch keeps them.
DROP TRIGGER IF EXISTS user_role_assignments_realtime_session_trg ON public.user_role_assignments;
DROP TRIGGER IF EXISTS users_realtime_session_delete_trg ON public.users;
DROP TRIGGER IF EXISTS users_realtime_session_update_trg ON public.users;

CREATE OR REPLACE FUNCTION public.cerp_realtime_bump_session_epoch()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
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

  PERFORM pg_notify(
    'cerp_realtime_control',
    json_build_object('kind', 'session_revoked', 'userId', v_user_id)::text
  );

  IF v_old_user_id IS NOT NULL THEN
    INSERT INTO public.realtime_session_epochs (user_id, session_epoch, updated_at)
    VALUES (v_old_user_id, 1, clock_timestamp())
    ON CONFLICT (user_id) DO UPDATE
      SET session_epoch = public.realtime_session_epochs.session_epoch + 1,
          updated_at = clock_timestamp();
    PERFORM pg_notify(
      'cerp_realtime_control',
      json_build_object('kind', 'session_revoked', 'userId', v_old_user_id)::text
    );
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.cerp_realtime_bump_session_epoch() TO PUBLIC;

CREATE TRIGGER users_realtime_session_update_trg
AFTER UPDATE OF password, role, status ON public.users
FOR EACH ROW
WHEN (
  OLD.password IS DISTINCT FROM NEW.password
  OR OLD.role IS DISTINCT FROM NEW.role
  OR OLD.status IS DISTINCT FROM NEW.status
)
EXECUTE FUNCTION public.cerp_realtime_bump_session_epoch();

CREATE TRIGGER users_realtime_session_delete_trg
AFTER DELETE ON public.users
FOR EACH ROW
EXECUTE FUNCTION public.cerp_realtime_bump_session_epoch();

CREATE TRIGGER user_role_assignments_realtime_session_trg
AFTER INSERT OR UPDATE OR DELETE ON public.user_role_assignments
FOR EACH ROW
EXECUTE FUNCTION public.cerp_realtime_bump_session_epoch();

DO $provenance$
DECLARE
  v_inherited_v1 boolean;
BEGIN
  SELECT inherited_v1 INTO v_inherited_v1
  FROM public.realtime_control_plane_v2_provenance
  WHERE singleton;

  IF NOT COALESCE(v_inherited_v1, false) THEN
    EXECUTE 'DROP TRIGGER user_role_assignments_realtime_session_trg ON public.user_role_assignments';
    EXECUTE 'DROP TRIGGER users_realtime_session_delete_trg ON public.users';
    EXECUTE 'DROP TRIGGER users_realtime_session_update_trg ON public.users';
    EXECUTE 'DROP FUNCTION public.cerp_realtime_bump_session_epoch()';
  END IF;
END
$provenance$;

COMMIT;
