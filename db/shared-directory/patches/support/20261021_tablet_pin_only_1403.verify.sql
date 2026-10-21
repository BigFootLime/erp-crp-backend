-- READ ONLY verification for TABLET-PIN-ONLY-20261021.
SELECT
  EXISTS (
    SELECT 1 FROM pg_index i
    JOIN pg_class c ON c.oid=i.indexrelid
    JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=i.indkey[0]
    WHERE i.indrelid='public.cerp_directory_tablet_pins'::regclass
      AND c.relnamespace='public'::regnamespace
      AND c.relname='cerp_directory_tablet_pins_lookup_hash_uq'
      AND i.indisunique AND i.indisvalid AND i.indisready
      AND i.indnkeyatts=1 AND a.attname='pin_lookup_hash'
      AND pg_get_expr(i.indpred,i.indrelid)='(pin_lookup_hash IS NOT NULL)'
  ) AS unique_lookup_index_valid,
  count(*) FILTER (WHERE pin_hash IS NOT NULL) AS configured_pin_count,
  count(*) FILTER (WHERE pin_hash IS NOT NULL AND pin_lookup_hash IS NOT NULL AND pin_verifier_version=2 AND pin_key_fingerprint IS NOT NULL) AS pin_only_v2_rows,
  count(*) FILTER (WHERE pin_hash IS NOT NULL AND pin_lookup_hash IS NULL) AS legacy_reconfiguration_required_count,
  count(*) FILTER (WHERE pin_lookup_hash IS NOT NULL AND (pin_verifier_version IS DISTINCT FROM 2 OR pin_key_fingerprint IS NULL)) AS malformed_pin_only_count
FROM public.cerp_directory_tablet_pins;
