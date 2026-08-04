SELECT
  to_regclass('public.replenishment_proposals') IS NOT NULL AS has_proposals,
  to_regclass('public.replenishment_proposal_events') IS NOT NULL AS has_events,
  to_regclass('public.replenishment_proposal_idempotence') IS NOT NULL AS has_idempotence,
  to_regclass('public.replenishment_budgets') IS NOT NULL AS has_budgets;

SELECT conname, convalidated
FROM pg_constraint
WHERE conname IN (
  'replenishment_proposals_stock_level_uniq',
  'replenishment_proposals_status_chk',
  'commande_fournisseur_replenishment_fkey'
)
ORDER BY conname;

SELECT indexname
FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname IN (
    'commande_fournisseur_replenishment_idx',
    'replenishment_proposals_status_idx',
    'replenishment_proposals_article_site_idx'
  )
ORDER BY indexname;
