-- SEC-CERP-0004 - Shared PostgreSQL Socket.IO control plane.
-- Additive/idempotent: durable session epochs plus an ordered retained event log.

BEGIN;

CREATE TABLE IF NOT EXISTS public.realtime_session_epochs (
  user_id bigint PRIMARY KEY,
  session_epoch bigint NOT NULL DEFAULT 0 CHECK (session_epoch >= 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS public.realtime_event_log (
  sequence bigserial PRIMARY KEY,
  event_id uuid NOT NULL DEFAULT gen_random_uuid(),
  deduplication_key text NOT NULL,
  stream_id text NOT NULL,
  event_name text NOT NULL,
  payload jsonb NOT NULL,
  targets jsonb NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT (clock_timestamp() + interval '24 hours'),
  CONSTRAINT realtime_event_log_event_id_uq UNIQUE (event_id),
  CONSTRAINT realtime_event_log_deduplication_key_uq UNIQUE (deduplication_key),
  CONSTRAINT realtime_event_log_stream_ck CHECK (btrim(stream_id) <> '' AND length(stream_id) <= 256),
  CONSTRAINT realtime_event_log_name_ck CHECK (btrim(event_name) <> '' AND length(event_name) <= 128),
  CONSTRAINT realtime_event_log_targets_ck CHECK (jsonb_typeof(targets) = 'array' AND jsonb_array_length(targets) > 0),
  CONSTRAINT realtime_event_log_retention_ck CHECK (expires_at > occurred_at)
);

CREATE INDEX IF NOT EXISTS realtime_event_log_expires_idx
  ON public.realtime_event_log (expires_at, sequence);
CREATE INDEX IF NOT EXISTS realtime_event_log_stream_sequence_idx
  ON public.realtime_event_log (stream_id, sequence);

CREATE OR REPLACE FUNCTION public.cerp_realtime_bump_session_epoch()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
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
$$;

DROP TRIGGER IF EXISTS users_realtime_session_update_trg ON public.users;
CREATE TRIGGER users_realtime_session_update_trg
AFTER UPDATE OF password, role, status ON public.users
FOR EACH ROW
WHEN (
  OLD.password IS DISTINCT FROM NEW.password
  OR OLD.role IS DISTINCT FROM NEW.role
  OR OLD.status IS DISTINCT FROM NEW.status
)
EXECUTE FUNCTION public.cerp_realtime_bump_session_epoch();

DROP TRIGGER IF EXISTS users_realtime_session_delete_trg ON public.users;
CREATE TRIGGER users_realtime_session_delete_trg
AFTER DELETE ON public.users
FOR EACH ROW
EXECUTE FUNCTION public.cerp_realtime_bump_session_epoch();

DROP TRIGGER IF EXISTS user_role_assignments_realtime_session_trg ON public.user_role_assignments;
CREATE TRIGGER user_role_assignments_realtime_session_trg
AFTER INSERT OR UPDATE OR DELETE ON public.user_role_assignments
FOR EACH ROW
EXECUTE FUNCTION public.cerp_realtime_bump_session_epoch();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app') THEN
    GRANT SELECT, INSERT, UPDATE ON public.realtime_session_epochs TO cerp_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.realtime_event_log TO cerp_app;
    GRANT USAGE, SELECT ON SEQUENCE public.realtime_event_log_sequence_seq TO cerp_app;
  END IF;
END $$;

COMMIT;
