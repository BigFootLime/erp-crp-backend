DO $$ BEGIN
  IF to_regclass('public.production_material_debit_sources') IS NULL OR
     to_regclass('public.production_material_debits') IS NULL OR
     to_regclass('public.production_quantity_declarations') IS NULL THEN
    RAISE EXCEPTION 'Material debit prerequisites are missing';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.production_material_debit_sources'::regclass AND attname='actual_qty' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'Measured debit quantity prerequisite is missing';
  END IF;
END $$;
