-- Canonical Directory-only tablet PIN credentials. These rows are never used by
-- terminal/kiosk authentication and do not contain a recoverable PIN.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
CREATE TABLE IF NOT EXISTS public.cerp_directory_tablet_pins (
  profile_id uuid PRIMARY KEY REFERENCES public.cerp_directory_profiles(profile_id) ON DELETE CASCADE,
  pin_hash text NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK(version > 0),
  changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.cerp_directory_tablet_devices (
  device_id uuid PRIMARY KEY,
  profile_id uuid NOT NULL REFERENCES public.cerp_directory_profiles(profile_id) ON DELETE CASCADE,
  label text NOT NULL CHECK(length(label) BETWEEN 1 AND 80),
  device_secret_hash text NOT NULL,
  revoked_at timestamptz,
  failed_attempts integer NOT NULL DEFAULT 0 CHECK(failed_attempts >= 0),
  locked_until timestamptz,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cerp_directory_tablet_devices_profile_idx ON public.cerp_directory_tablet_devices(profile_id) WHERE revoked_at IS NULL;
REVOKE ALL ON public.cerp_directory_tablet_pins,public.cerp_directory_tablet_devices FROM PUBLIC,cerp_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.cerp_directory_tablet_pins,public.cerp_directory_tablet_devices TO cerp_directory_app;
COMMIT;
