BEGIN READ ONLY;
SET LOCAL statement_timeout = '15s';
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid = 'public.quality_control'::regclass
      AND conname = 'quality_control_context_v2_chk' AND convalidated
  ) THEN
    RAISE EXCEPTION 'The validated predecessor quality control constraint is missing';
  END IF;
  IF to_regclass('public.reception_processing_events') IS NULL
    OR to_regclass('public.quality_release_decision') IS NULL
    OR to_regclass('public.quality_command_receipts') IS NULL THEN
    RAISE EXCEPTION 'A receipt operator ledger dependency is missing';
  END IF;
END $$;
SELECT current_database() AS database, count(*) AS quality_controls,
  md5(coalesce(string_agg(md5(to_jsonb(c)::text), '' ORDER BY c.id), '')) AS existing_controls_hash
FROM public.quality_control c;
ROLLBACK;
