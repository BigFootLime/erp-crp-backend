\set ON_ERROR_STOP on
DO $$ BEGIN
  IF to_regclass('public.production_material_remnants') IS NULL OR to_regclass('public.production_material_transfer_events') IS NULL THEN RAISE EXCEPTION 'Material remnant registries missing'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.production_material_debits'::regclass AND conname='production_material_debits_declaration_id_fkey' AND condeferrable AND condeferred) THEN RAISE EXCEPTION 'Material declaration FK must be deferred'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.production_material_debit_sources'::regclass AND conname='production_material_debit_sources_measured_pair_chk' AND convalidated) THEN RAISE EXCEPTION 'Measured quantity constraint missing'; END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE tgname IN('production_material_remnants_immutable','production_material_transfer_events_immutable') AND tgenabled='O')<>2 THEN RAISE EXCEPTION 'Immutable material history triggers missing'; END IF;
END $$;
SELECT id FROM public.production_material_remnants LIMIT 0;
SELECT id FROM public.production_material_transfer_events LIMIT 0;
SELECT 'material remnants, signed yield and transfer history: verified' AS result;
