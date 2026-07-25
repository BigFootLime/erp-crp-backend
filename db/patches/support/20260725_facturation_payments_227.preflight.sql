\set ON_ERROR_STOP on

-- Read-only preflight for issue #227. It intentionally does not enable Finance.
DO $$
BEGIN
  IF current_database() <> 'cerp_test' THEN
    RAISE EXCEPTION '#227 preflight is restricted to cerp_test';
  END IF;
END $$;

SELECT current_database() AS database_name, current_user AS database_user, now() AS checked_at;

SELECT prerequisite, present
FROM (
  VALUES
    ('facture', to_regclass('public.facture') IS NOT NULL),
    ('facture_ligne', to_regclass('public.facture_ligne') IS NOT NULL),
    ('avoir', to_regclass('public.avoir') IS NOT NULL),
    ('avoir_ligne', to_regclass('public.avoir_ligne') IS NOT NULL),
    ('paiement', to_regclass('public.paiement') IS NOT NULL),
    ('clients', to_regclass('public.clients') IS NOT NULL),
    ('users', to_regclass('public.users') IS NOT NULL),
    ('documents_clients', to_regclass('public.documents_clients') IS NOT NULL),
    ('bon_livraison_ligne', to_regclass('public.bon_livraison_ligne') IS NOT NULL),
    ('commande_ligne', to_regclass('public.commande_ligne') IS NOT NULL),
    ('gen_random_uuid', to_regprocedure('gen_random_uuid()') IS NOT NULL)
) AS checks(prerequisite, present)
ORDER BY prerequisite;

SELECT table_name, column_name, data_type, udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND (
    (table_name IN ('facture', 'facture_ligne', 'avoir', 'avoir_ligne', 'paiement') AND column_name = 'id')
    OR (table_name = 'bon_livraison_ligne' AND column_name = 'id')
    OR (table_name = 'facture' AND column_name IN ('client_id', 'total_ttc', 'statut', 'numero'))
    OR (table_name = 'avoir' AND column_name IN ('client_id', 'total_ttc', 'facture_id', 'statut', 'numero'))
    OR (table_name = 'paiement' AND column_name IN ('facture_id', 'client_id', 'montant'))
  )
ORDER BY table_name, ordinal_position;

SELECT
  to_regclass('public.facture_id_seq') IS NOT NULL AS facture_sequence_present,
  to_regclass('public.avoir_id_seq') IS NOT NULL AS avoir_sequence_present,
  to_regclass('public.paiement_id_seq') IS NOT NULL AS paiement_sequence_present,
  to_regclass('public.finance_legal_sequences') IS NOT NULL AS issue_227_already_present;

SELECT statut, count(*) AS rows_count FROM public.facture GROUP BY statut ORDER BY statut;
SELECT statut, count(*) AS rows_count FROM public.avoir GROUP BY statut ORDER BY statut;

SELECT
  count(*) FILTER (WHERE total_ttc IS NULL OR total_ttc < 0) AS invalid_facture_totals,
  count(*) FILTER (WHERE client_id IS NULL OR btrim(client_id) = '') AS invalid_facture_clients
FROM public.facture;

SELECT
  count(*) FILTER (WHERE montant IS NULL OR montant < 0) AS invalid_payment_amounts,
  count(*) FILTER (WHERE facture_id IS NULL) AS payments_without_invoice
FROM public.paiement;

SELECT
  count(*) FILTER (WHERE a.facture_id IS NOT NULL AND a.client_id IS DISTINCT FROM f.client_id) AS credit_invoice_client_mismatches
FROM public.avoir a
LEFT JOIN public.facture f ON f.id = a.facture_id;
