-- Preflight #433 — révision de gamme. LECTURE SEULE.
-- À exécuter avant le patch, sur cerp_test puis (après validation humaine) cerp_prod.

\echo '--- Table cible ---'
SELECT to_regclass('public.gammes') AS gammes_table;

\echo '--- Colonnes déjà présentes (attendu: 0 ligne avant application) ---'
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'gammes'
  AND column_name IN ('source_gamme_id', 'revision_idempotency_key')
ORDER BY column_name;

\echo '--- Index/contraintes homonymes (attendu: 0 ligne) ---'
SELECT indexname FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname IN ('gammes_revision_idempotency_uidx', 'gammes_source_gamme_id_idx');
SELECT conname FROM pg_constraint
WHERE conrelid = 'public.gammes'::regclass AND conname = 'gammes_source_gamme_id_fkey';

\echo '--- Volumétrie (le patch n''écrit aucune donnée) ---'
SELECT count(*) AS gammes_total,
       count(*) FILTER (WHERE statut = 'APPLICABLE') AS gammes_applicables,
       count(*) FILTER (WHERE statut = 'BROUILLON') AS gammes_brouillon
FROM public.gammes;

\echo '--- Sauvegarde: vérifier qu''un dump récent existe AVANT d''appliquer ---'
