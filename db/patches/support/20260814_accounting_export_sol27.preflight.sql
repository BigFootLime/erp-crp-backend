\set ON_ERROR_STOP on
DO $$
BEGIN
  IF current_setting('server_version_num')::int < 140000 THEN
    RAISE EXCEPTION 'SOL-27 requires PostgreSQL 14 or newer';
  END IF;
  IF to_regclass('public.users') IS NULL OR to_regclass('public.facture') IS NULL
     OR to_regclass('public.facture_ligne') IS NULL OR to_regclass('public.avoir') IS NULL
     OR to_regclass('public.avoir_ligne') IS NULL OR to_regclass('public.paiement') IS NULL
     OR to_regclass('public.clients') IS NULL THEN
    RAISE EXCEPTION 'SOL-27 finance source tables are missing';
  END IF;
  IF EXISTS (SELECT 1 FROM public.facture WHERE document_status='ISSUED' AND (currency IS NULL OR currency !~ '^[A-Z]{3}$')) THEN
    RAISE EXCEPTION 'SOL-27 issued invoices contain an invalid currency';
  END IF;
  IF EXISTS (SELECT 1 FROM public.avoir WHERE statut IN ('ISSUED','emis','emise','envoyee') AND (currency IS NULL OR currency !~ '^[A-Z]{3}$')) THEN
    RAISE EXCEPTION 'SOL-27 issued credit notes contain an invalid currency';
  END IF;
END $$;

SELECT current_database() AS database_name,current_setting('server_version') AS server_version,
       pg_size_pretty(pg_database_size(current_database())) AS database_size,
       (SELECT count(*) FROM public.facture WHERE document_status='ISSUED') AS issued_invoices,
       (SELECT count(*) FROM public.avoir WHERE statut IN ('ISSUED','emis','emise','envoyee')) AS issued_credit_notes,
       (SELECT count(*) FROM public.paiement WHERE status NOT IN ('REJECTED','REVERSED') AND workflow_status<>'REVERSED') AS eligible_payments,
       (SELECT count(*) FROM public.clients WHERE NULLIF(btrim(compte_tiers),'') IS NULL) AS clients_without_third_party_account;
