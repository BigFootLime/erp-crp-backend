SELECT current_database() AS database_name,
       to_regclass('public.data_cutover_batches') IS NOT NULL AS preparation_installed,
       to_regclass('public.cutover_finance_shared_sequences') IS NOT NULL AS shared_finance_series_installed,
       to_regclass('public.proforma_client_reference_seq') IS NOT NULL AS proforma_sequence_installed;
DO $$ BEGIN
  IF to_regclass('public.data_cutover_batches') IS NULL
     OR to_regclass('public.cutover_finance_shared_sequences') IS NULL
     OR to_regclass('public.proforma_client_reference_seq') IS NULL THEN
    RAISE EXCEPTION 'Install cutover preparation and numbering patches before financial gate patch';
  END IF;
END $$;
