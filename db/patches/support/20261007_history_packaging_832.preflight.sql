DO $$ BEGIN
 IF to_regclass('public.piece_technique_versions') IS NULL OR to_regclass('public.of_output_lots') IS NULL OR to_regclass('public.identification_labels') IS NULL OR to_regprocedure('public.prevent_material_debit_rewrite()') IS NULL THEN RAISE EXCEPTION 'History/packaging prerequisites missing'; END IF;
END $$;
