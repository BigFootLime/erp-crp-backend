-- READ ONLY preflight for TABLET-PIN-ONLY-20261021.
SELECT
  to_regclass('public.cerp_directory_tablet_pins') IS NOT NULL AS pin_table_present,
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='cerp_directory_tablet_pins' AND column_name='pin_lookup_hash') AS lookup_column_present,
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='cerp_directory_tablet_pins' AND column_name='pin_verifier_version') AS verifier_column_present,
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='cerp_directory_tablet_pins' AND column_name='pin_key_fingerprint') AS fingerprint_column_present,
  (SELECT count(*) FROM public.cerp_directory_tablet_pins WHERE pin_hash IS NOT NULL) AS configured_pin_count_at_preflight;
