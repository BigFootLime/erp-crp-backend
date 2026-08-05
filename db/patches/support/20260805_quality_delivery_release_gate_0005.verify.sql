\set ON_ERROR_STOP on

SELECT check_name, ok
FROM (VALUES
  ('policy_table', to_regclass('public.quality_delivery_release_policy') IS NOT NULL),
  ('pack_evidence_table', to_regclass('public.bon_livraison_pack_quality_documents') IS NOT NULL),
  ('pack_quality_state', EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='bon_livraison_pack_versions' AND column_name='quality_release_state'
  )),
  ('policy_guard', EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname='trg_quality_delivery_release_policy_guard_0005' AND NOT tgisinternal
  )),
  ('pack_snapshot_guard', EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname='trg_bon_livraison_pack_snapshot_guard_0005' AND NOT tgisinternal
  )),
  ('evidence_append_only', EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname='trg_bon_livraison_pack_quality_documents_append_only_0005' AND NOT tgisinternal
  )),
  ('no_unsigned_policy_selected', NOT EXISTS (
    SELECT 1 FROM public.quality_delivery_release_policy
    WHERE status='SIGNED' AND (signed_by IS NULL OR signed_at IS NULL OR signature_reference IS NULL)
  ))
) AS checks(check_name, ok)
ORDER BY check_name;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM (VALUES
      (to_regclass('public.quality_delivery_release_policy') IS NOT NULL),
      (to_regclass('public.bon_livraison_pack_quality_documents') IS NOT NULL),
      (EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='trg_bon_livraison_pack_snapshot_guard_0005' AND NOT tgisinternal))
    ) AS required(ok) WHERE NOT ok
  ) THEN
    RAISE EXCEPTION 'GPT56-FEAT-CERP-0005 verification failed';
  END IF;
END;
$$;
