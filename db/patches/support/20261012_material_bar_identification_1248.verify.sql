DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='stock_material_bars'
    AND column_name='public_number' AND is_identity='YES' AND is_nullable='NO') THEN
    RAISE EXCEPTION 'Material bar public number identity is missing';
  END IF;
  IF EXISTS (SELECT 1 FROM public.stock_material_bars WHERE public_number<=0) OR EXISTS (
    SELECT public_number FROM public.stock_material_bars GROUP BY public_number HAVING count(*)>1
  ) THEN RAISE EXCEPTION 'Material bar numbers must be positive and unique'; END IF;
  IF position('public_number' IN pg_get_functiondef('public.protect_material_bar_identity_1246()'::regprocedure))=0 THEN
    RAISE EXCEPTION 'Material bar public number is not protected';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.identification_labels'::regclass
    AND conname='identification_labels_entity_type_ck' AND position('STOCK_MATERIAL_BAR' IN pg_get_constraintdef(oid))>0) THEN
    RAISE EXCEPTION 'Material bar labels are not enabled';
  END IF;
END $$;
