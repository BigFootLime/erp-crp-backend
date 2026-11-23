DO $$
BEGIN
  IF to_regclass('public.crp_piece_plan_counters') IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_index
    WHERE indexrelid = to_regclass('public.pieces_techniques_crp_plan_reference_uidx')
      AND indisunique AND indisvalid
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.pieces_techniques'::regclass
      AND conname = 'pieces_techniques_commercial_scope_ck'
      AND convalidated
  ) THEN
    RAISE EXCEPTION 'CRP technical piece numbering schema is incomplete';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app') THEN
    IF NOT has_table_privilege('cerp_app','public.crp_piece_plan_counters','SELECT')
      OR NOT has_table_privilege('cerp_app','public.crp_piece_plan_counters','INSERT')
      OR NOT has_table_privilege('cerp_app','public.crp_piece_plan_counters','UPDATE') THEN
      RAISE EXCEPTION 'CRP technical piece counter permissions are incomplete';
    END IF;
  END IF;
END $$;
