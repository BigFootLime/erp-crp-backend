-- Directory-only credentials for neutral, shared workshop tablets. A device is
-- never assigned to a profile: every operator authenticates explicitly.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
CREATE TABLE IF NOT EXISTS public.cerp_directory_tablet_pins (
  profile_id uuid PRIMARY KEY REFERENCES public.cerp_directory_profiles(profile_id) ON DELETE CASCADE,
  pin_hash text NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK(version > 0),
  changed_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.cerp_directory_tablet_pins ALTER COLUMN pin_hash DROP NOT NULL;
CREATE TABLE IF NOT EXISTS public.cerp_directory_tablet_devices (
  device_id uuid PRIMARY KEY,
  database_id text NOT NULL,
  label text NOT NULL CHECK(length(label) BETWEEN 1 AND 80),
  device_secret_hash text,
  pairing_code_hash text,
  pairing_expires_at timestamptz,
  paired_at timestamptz,
  revoked_at timestamptz,
  failed_attempts integer NOT NULL DEFAULT 0 CHECK(failed_attempts >= 0),
  locked_until timestamptz,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cerp_directory_tablet_devices_pairing_ck CHECK ((revoked_at IS NOT NULL AND device_secret_hash IS NULL AND pairing_code_hash IS NULL AND pairing_expires_at IS NULL) OR (revoked_at IS NULL AND device_secret_hash IS NOT NULL AND pairing_code_hash IS NULL AND pairing_expires_at IS NULL) OR (revoked_at IS NULL AND device_secret_hash IS NULL AND pairing_code_hash IS NOT NULL AND pairing_expires_at IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS public.cerp_directory_tablet_rate_limits (
  scope text NOT NULL CHECK(scope IN ('ip','account_device')),
  key_hash text NOT NULL,
  window_started_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  locked_until timestamptz,
  PRIMARY KEY(scope,key_hash)
);
ALTER TABLE public.cerp_directory_sessions ADD COLUMN IF NOT EXISTS tablet_device_id uuid REFERENCES public.cerp_directory_tablet_devices(device_id);
ALTER TABLE public.cerp_directory_challenges ADD COLUMN IF NOT EXISTS tablet_device_id uuid REFERENCES public.cerp_directory_tablet_devices(device_id);
ALTER TABLE public.cerp_directory_sessions ADD COLUMN IF NOT EXISTS tablet_pin_version integer;
ALTER TABLE public.cerp_directory_challenges ADD COLUMN IF NOT EXISTS tablet_pin_version integer;
ALTER TABLE public.cerp_directory_challenges ADD COLUMN IF NOT EXISTS tablet_pin_profile_id uuid REFERENCES public.cerp_directory_profiles(profile_id);
CREATE INDEX IF NOT EXISTS cerp_directory_tablet_devices_active_idx ON public.cerp_directory_tablet_devices(device_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS cerp_directory_sessions_tablet_device_idx ON public.cerp_directory_sessions(tablet_device_id) WHERE tablet_device_id IS NOT NULL;
REVOKE ALL ON public.cerp_directory_tablet_pins,public.cerp_directory_tablet_devices,public.cerp_directory_tablet_rate_limits FROM PUBLIC,cerp_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.cerp_directory_tablet_pins,public.cerp_directory_tablet_devices,public.cerp_directory_tablet_rate_limits TO cerp_directory_app;
COMMIT;
