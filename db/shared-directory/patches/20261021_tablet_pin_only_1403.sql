-- TABLET-PIN-ONLY-20261021: indexed, unique PIN-only lookup for the
-- canonical shared Directory. Existing bcrypt PINs intentionally remain
-- lookup-less and require a normal password/MFA reconfiguration before use.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $$
BEGIN
  IF to_regclass('public.cerp_directory_tablet_pins') IS NULL THEN
    RAISE EXCEPTION 'Tablet PIN Directory schema missing';
  END IF;
END $$;

ALTER TABLE public.cerp_directory_tablet_pins
  ADD COLUMN IF NOT EXISTS pin_lookup_hash text NULL,
  ADD COLUMN IF NOT EXISTS pin_verifier_version smallint NULL,
  ADD COLUMN IF NOT EXISTS pin_key_fingerprint text NULL;

ALTER TABLE public.cerp_directory_tablet_pins
  DROP CONSTRAINT IF EXISTS cerp_directory_tablet_pins_lookup_hash_ck,
  ADD CONSTRAINT cerp_directory_tablet_pins_lookup_hash_ck
    CHECK (pin_lookup_hash IS NULL OR pin_lookup_hash ~ '^[0-9a-f]{64}$');
ALTER TABLE public.cerp_directory_tablet_pins
  DROP CONSTRAINT IF EXISTS cerp_directory_tablet_pins_verifier_version_ck,
  ADD CONSTRAINT cerp_directory_tablet_pins_verifier_version_ck
    CHECK (pin_verifier_version IS NULL OR pin_verifier_version = 2);
ALTER TABLE public.cerp_directory_tablet_pins
  DROP CONSTRAINT IF EXISTS cerp_directory_tablet_pins_key_fingerprint_ck,
  ADD CONSTRAINT cerp_directory_tablet_pins_key_fingerprint_ck
    CHECK (pin_key_fingerprint IS NULL OR pin_key_fingerprint ~ '^[0-9a-f]{64}$');
ALTER TABLE public.cerp_directory_tablet_pins
  DROP CONSTRAINT IF EXISTS cerp_directory_tablet_pins_pin_only_shape_ck,
  ADD CONSTRAINT cerp_directory_tablet_pins_pin_only_shape_ck
    CHECK ((pin_lookup_hash IS NULL AND pin_verifier_version IS NULL AND pin_key_fingerprint IS NULL)
       OR (pin_lookup_hash IS NOT NULL AND pin_verifier_version = 2 AND pin_key_fingerprint IS NOT NULL));

CREATE UNIQUE INDEX IF NOT EXISTS cerp_directory_tablet_pins_lookup_hash_uq
  ON public.cerp_directory_tablet_pins(pin_lookup_hash)
  WHERE pin_lookup_hash IS NOT NULL;

COMMENT ON COLUMN public.cerp_directory_tablet_pins.pin_lookup_hash IS
  'HMAC lookup for PIN-only tablet login. Never a PIN or bcrypt verifier; legacy rows remain NULL until reconfigured.';
COMMENT ON COLUMN public.cerp_directory_tablet_pins.pin_key_fingerprint IS
  'Non-secret HMAC-key fingerprint. A mismatch requires PIN reconfiguration after supervised key rotation.';
COMMIT;
