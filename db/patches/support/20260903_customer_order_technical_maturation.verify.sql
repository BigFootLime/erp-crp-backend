SELECT to_regclass('public.commande_quick_piece_idempotence') AS quick_piece_idempotence_table;

SELECT has_table_privilege('cerp_app', 'public.commande_quick_piece_idempotence', 'SELECT,INSERT,UPDATE')
  AS quick_piece_app_access;

SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN ('affaire', 'ordres_fabrication')
  AND column_name IN (
    'parent_affaire_id', 'delivery_readiness_state', 'technical_readiness',
    'technical_preparation', 'technical_submitted_at', 'technical_validated_at'
  )
ORDER BY table_name, ordinal_position;

SELECT technical_readiness, count(*)
FROM public.ordres_fabrication
GROUP BY technical_readiness
ORDER BY technical_readiness;

SELECT count(*) AS invalid_non_draft_of
FROM public.ordres_fabrication
WHERE statut::text <> 'BROUILLON'
  AND technical_readiness <> 'VALIDATED';

SELECT
  count(*) FILTER (
    WHERE NOT is_principal
      AND commande_id IS NOT NULL
      AND parent_affaire_id IS NULL
  ) AS tranches_sans_parent,
  count(DISTINCT commande_id) FILTER (WHERE is_principal) AS commandes_avec_principale
FROM public.affaire;
