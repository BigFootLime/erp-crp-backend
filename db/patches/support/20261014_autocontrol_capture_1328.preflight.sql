DO $$ DECLARE relation text; BEGIN
  FOREACH relation IN ARRAY ARRAY['quality_control','quality_documents','quality_control_points','of_operations','users'] LOOP
    IF to_regclass('public.'||relation) IS NULL THEN RAISE EXCEPTION 'Autocontrol prerequisite missing: %',relation; END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.quality_control'::regclass AND attname='operation_id' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'Autocontrol operation scope missing';
  END IF;
END $$;
SELECT current_database() AS database_name,now() AS preflight_at,'No existing measurements or documents rewritten' AS scope;
