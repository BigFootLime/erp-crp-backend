-- Verify #433 — révision de gamme. LECTURE SEULE, à exécuter APRÈS le patch.
-- Attendu : 2 colonnes, 1 contrainte FK, 2 index, et AUCUNE donnée modifiée.

\echo '--- Colonnes (attendu: 2 lignes, nullables) ---'
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'gammes'
  AND column_name IN ('source_gamme_id', 'revision_idempotency_key')
ORDER BY column_name;

\echo '--- Contrainte de filiation (attendu: 1 ligne) ---'
SELECT conname, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid = 'public.gammes'::regclass AND conname = 'gammes_source_gamme_id_fkey';

\echo '--- Index (attendu: 2 lignes) ---'
SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname IN ('gammes_revision_idempotency_uidx', 'gammes_source_gamme_id_idx')
ORDER BY indexname;

\echo '--- Aucune donnée écrite par le patch (attendu: 0) ---'
SELECT count(*) AS gammes_avec_filiation
FROM public.gammes
WHERE source_gamme_id IS NOT NULL OR revision_idempotency_key IS NOT NULL;

\echo '--- Les gammes existantes sont intactes ---'
SELECT count(*) AS gammes_total,
       count(*) FILTER (WHERE statut = 'APPLICABLE') AS gammes_applicables
FROM public.gammes;
