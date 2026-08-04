SELECT
  to_regclass('public.replenishment_proposals') IS NOT NULL AS has_proposals,
  to_regclass('public.replenishment_proposal_events') IS NOT NULL AS has_events,
  to_regclass('public.replenishment_proposal_idempotence') IS NOT NULL AS has_idempotence,
  to_regclass('public.replenishment_budgets') IS NOT NULL AS has_budgets;

SELECT module_key, '/replenishment-proposals' = ANY(api_prefixes) AS has_replenishment_prefix
FROM public.app_modules
WHERE module_key = 'commandes-fournisseurs';

SELECT conname, convalidated
FROM pg_constraint
WHERE conname IN (
  'replenishment_proposals_status_chk',
  'replenishment_proposals_values_chk',
  'commande_fournisseur_replenishment_fkey'
)
ORDER BY conname;

SELECT indexname
FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname IN (
    'commande_fournisseur_replenishment_idx',
    'replenishment_proposals_status_idx',
    'replenishment_proposals_article_site_uniq',
    'replenishment_proposals_article_unmapped_uniq'
  )
ORDER BY indexname;

SELECT article_id, magasin_id, count(*) AS duplicate_count
FROM public.replenishment_proposals
GROUP BY article_id, magasin_id
HAVING count(*) > 1;
