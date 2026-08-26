-- Read-only preflight for 20260826_commande_ar_versioning_and_send_guard.sql.
BEGIN TRANSACTION READ ONLY;

SELECT
  to_regclass('public.commande_client') IS NOT NULL AS has_commande_client,
  to_regclass('public.commande_ar_log') IS NOT NULL AS has_commande_ar_log,
  to_regclass('public.documents_clients') IS NOT NULL AS has_documents_clients,
  to_regclass('public.commande_ligne_affaire_allocation') IS NOT NULL AS has_allocations,
  count(*)::bigint AS ar_count,
  count(*) FILTER (WHERE document_id IS NULL)::bigint AS ar_without_document,
  count(*) FILTER (WHERE generated_at IS NULL)::bigint AS ar_without_generated_at
FROM public.commande_ar_log;

-- These rows are not modified by the patch; resolve them before applying if
-- they exist because their foreign-key integrity is already broken.
SELECT l.id::text AS ar_id, l.commande_id, l.document_id::text AS document_id
FROM public.commande_ar_log l
LEFT JOIN public.commande_client c ON c.id = l.commande_id
LEFT JOIN public.documents_clients d ON d.id = l.document_id
WHERE c.id IS NULL OR d.id IS NULL
ORDER BY l.generated_at, l.id;

SELECT commande_id, generated_at, count(*)::int AS same_generation_timestamp_count
FROM public.commande_ar_log
GROUP BY commande_id, generated_at
HAVING count(*) > 1
ORDER BY commande_id, generated_at;

ROLLBACK;
