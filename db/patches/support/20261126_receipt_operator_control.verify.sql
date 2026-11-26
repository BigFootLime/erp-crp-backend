BEGIN READ ONLY;
SET LOCAL statement_timeout = '15s';
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid = 'public.quality_control'::regclass
      AND conname = 'quality_control_context_v3_chk' AND convalidated
  ) OR EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid = 'public.quality_control'::regclass
      AND conname = 'quality_control_context_v2_chk'
  ) THEN
    RAISE EXCEPTION 'The quality control constraint did not migrate cleanly';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.quality_control'::regclass
      AND tgname = 'guard_quality_operator_receipt_control' AND tgenabled = 'O'
  ) THEN
    RAISE EXCEPTION 'The raw-material receipt scope trigger is missing or disabled';
  END IF;
END $$;
SELECT current_database() AS database, count(*) FILTER (WHERE NOT c.operator_receipt_control) AS quality_controls,
  md5(coalesce(string_agg(md5((to_jsonb(c) - 'operator_receipt_control')::text), '' ORDER BY c.id)
    FILTER (WHERE NOT c.operator_receipt_control), '')) AS existing_controls_hash,
  count(*) FILTER (WHERE c.operator_receipt_control) AS operator_controls
FROM public.quality_control c;
ROLLBACK;
