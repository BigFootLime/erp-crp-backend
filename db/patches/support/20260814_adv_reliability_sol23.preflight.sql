\set ON_ERROR_STOP on

DO $$
DECLARE missing text[]:=ARRAY[]::text[];
BEGIN
  IF current_setting('server_version_num')::int<140000 THEN RAISE EXCEPTION 'PostgreSQL 14+ requis'; END IF;
  IF to_regclass('public.commande_client') IS NULL THEN missing:=array_append(missing,'commande_client'); END IF;
  IF to_regclass('public.commande_ligne') IS NULL THEN missing:=array_append(missing,'commande_ligne'); END IF;
  IF to_regclass('public.bon_livraison') IS NULL THEN missing:=array_append(missing,'bon_livraison'); END IF;
  IF to_regclass('public.bon_livraison_ligne') IS NULL THEN missing:=array_append(missing,'bon_livraison_ligne'); END IF;
  IF to_regclass('public.facture') IS NULL THEN missing:=array_append(missing,'facture'); END IF;
  IF to_regclass('public.facture_echeance') IS NULL THEN missing:=array_append(missing,'facture_echeance'); END IF;
  IF to_regclass('public.paiement_allocations') IS NULL THEN missing:=array_append(missing,'paiement_allocations'); END IF;
  IF to_regclass('public.avoir_source_allocations') IS NULL THEN missing:=array_append(missing,'avoir_source_allocations'); END IF;
  IF to_regclass('public.erp_audit_logs') IS NULL THEN missing:=array_append(missing,'erp_audit_logs'); END IF;
  IF array_length(missing,1) IS NOT NULL THEN RAISE EXCEPTION 'Prerequis SOL-23 manquants: %',array_to_string(missing,', '); END IF;
END $$;

SELECT current_database() AS database_name,current_setting('server_version') AS postgres_version,
       pg_size_pretty(pg_database_size(current_database())) AS database_size,
       (SELECT count(*) FROM public.commande_client) AS orders,
       (SELECT count(*) FROM public.bon_livraison) AS deliveries,
       (SELECT count(*) FROM public.facture) AS invoices;

SELECT count(*) AS invoices_without_currency FROM public.facture WHERE currency IS NULL OR btrim(currency)='';
SELECT count(*) AS issued_invoices_without_due_date FROM public.facture
 WHERE statut IN ('ISSUED','PARTIALLY_PAID','emis','emise','envoyee','partielle') AND date_echeance IS NULL;
