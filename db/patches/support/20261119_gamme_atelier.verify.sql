DO $$
BEGIN
  IF (SELECT count(*) FROM information_schema.columns
      WHERE table_schema='public' AND table_name='pieces_techniques_operations'
        AND column_name IN ('machine_ids','gamme_source_operation_id','programmation_minutes',
          'amelioration_continue','amelioration_id') AND is_nullable='YES') <> 5 THEN
    RAISE EXCEPTION 'Missing nullable routing metadata';
  END IF;
  IF (SELECT count(DISTINCT upper(btrim(code))) FROM public.centres_frais
      WHERE upper(btrim(code)) IN ('CF-FRAISAGE','CF-FRAISAGE-TRAD','CF-TOURNAGE','CF-TOURNAGE-TRAD',
        'CF-DECOUPE','CF-MAIN-OEUVRE','CF-PROGRAMMATION')) <> 7 THEN
    RAISE EXCEPTION 'Missing routing cost centre codes';
  END IF;
  IF to_regclass('public.gamme_improvement_receipts') IS NULL THEN
    RAISE EXCEPTION 'Missing improvement receipts table';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='cerp_app') THEN
    IF NOT has_table_privilege('cerp_app','public.gamme_improvement_receipts','SELECT')
      OR NOT has_table_privilege('cerp_app','public.gamme_improvement_receipts','INSERT') THEN
      RAISE EXCEPTION 'Missing improvement receipts permissions';
    END IF;
  END IF;
END $$;
