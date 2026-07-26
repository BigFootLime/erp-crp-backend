-- Préflight #275 — LECTURE SEULE. N'écrit rien, ne verrouille rien.
-- À exécuter sur la base cible AVANT le patch, et à relire avant d'appliquer.

\echo '=== Base cible ==='
SELECT current_database() AS database, current_user AS role, now() AS checked_at;

\echo ''
\echo '=== Tables requises (10 attendues) ==='
SELECT t AS table_name,
       CASE WHEN to_regclass(format('public.%I', t)) IS NULL THEN 'MANQUANTE' ELSE 'ok' END AS status
FROM unnest(ARRAY[
  'devis', 'commande_client', 'commande_ligne',
  'bon_livraison', 'bon_livraison_ligne',
  'facture', 'avoir', 'paiement',
  'paiement_allocations', 'avoir_source_allocations'
]) AS t
ORDER BY 1;

\echo ''
\echo '=== Index #275 deja presents (0 attendu avant la premiere application) ==='
SELECT indexname, tablename
FROM pg_indexes
WHERE schemaname = 'public' AND indexname LIKE '%\_275\_idx'
ORDER BY tablename, indexname;

\echo ''
\echo '=== Volumetrie de la chaine commerciale (dimensionne le cout du CREATE INDEX) ==='
SELECT 'devis' AS relation, count(*) AS rows FROM public.devis
UNION ALL SELECT 'commande_client', count(*) FROM public.commande_client
UNION ALL SELECT 'commande_ligne', count(*) FROM public.commande_ligne
UNION ALL SELECT 'bon_livraison', count(*) FROM public.bon_livraison
UNION ALL SELECT 'bon_livraison_ligne', count(*) FROM public.bon_livraison_ligne
UNION ALL SELECT 'facture', count(*) FROM public.facture
UNION ALL SELECT 'avoir', count(*) FROM public.avoir
UNION ALL SELECT 'paiement', count(*) FROM public.paiement
UNION ALL SELECT 'paiement_allocations', count(*) FROM public.paiement_allocations
UNION ALL SELECT 'avoir_source_allocations', count(*) FROM public.avoir_source_allocations
ORDER BY 1;

\echo ''
\echo '=== Vocabulaire de statut reellement present (doit tenir dans reporting-policy.ts) ==='
SELECT 'facture' AS relation, coalesce(statut, '(null)') AS statut, count(*) AS rows
FROM public.facture GROUP BY 1, 2
UNION ALL
SELECT 'avoir', coalesce(statut, '(null)'), count(*) FROM public.avoir GROUP BY 1, 2
UNION ALL
SELECT 'devis', coalesce(statut, '(null)'), count(*) FROM public.devis GROUP BY 1, 2
UNION ALL
SELECT 'bon_livraison', coalesce(statut, '(null)'), count(*) FROM public.bon_livraison GROUP BY 1, 2
UNION ALL
SELECT 'paiement.status', coalesce(status, '(null)'), count(*) FROM public.paiement GROUP BY 1, 2
ORDER BY 1, 2;

\echo ''
\echo '=== Devises presentes (un total global n''est produit que si une seule devise) ==='
SELECT 'facture' AS relation, upper(coalesce(currency, 'EUR')) AS currency, count(*) FROM public.facture GROUP BY 1, 2
UNION ALL SELECT 'avoir', upper(coalesce(currency, 'EUR')), count(*) FROM public.avoir GROUP BY 1, 2
UNION ALL SELECT 'paiement', upper(coalesce(currency, 'EUR')), count(*) FROM public.paiement GROUP BY 1, 2
UNION ALL SELECT 'clients', upper(coalesce(devise, 'EUR')), count(*) FROM public.clients GROUP BY 1, 2
ORDER BY 1, 2;

\echo ''
\echo '=== Anomalies connues, avant tout affichage ==='
SELECT 'factures du registre sans echeance' AS anomalie,
       count(*) AS rows
FROM public.facture
WHERE statut = ANY (ARRAY['ISSUED','PARTIALLY_PAID','PAID','emise','emis','envoyee','partielle','payee'])
  AND date_echeance IS NULL
UNION ALL
SELECT 'BL expedies sans date d''expedition',
       count(*)
FROM public.bon_livraison
WHERE statut = ANY (ARRAY['SHIPPED','DELIVERED']) AND date_expedition IS NULL
UNION ALL
SELECT 'lignes de BL sans ligne de commande',
       count(*)
FROM public.bon_livraison_ligne
WHERE commande_ligne_id IS NULL
UNION ALL
SELECT 'reglements non affectes',
       count(*)
FROM public.paiement p
WHERE p.facture_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM public.paiement_allocations pa WHERE pa.paiement_id = p.id)
ORDER BY 1;
