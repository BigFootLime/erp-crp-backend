-- Verify #461 — lecture seule, à exécuter après le patch.

\echo '--- Fonction d’immuabilité (attendu: 1 ligne, 3 contrôles true) ---'
WITH fn AS (
  SELECT pg_get_functiondef(p.oid) AS definition
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'fn_prevent_validated_piece_version_mutation'
)
SELECT
  definition LIKE '%Validated technical versions are immutable%' AS immutabilite_conservee,
  definition LIKE '%OLD.date_effet > CURRENT_DATE%' AS ancienne_date_future_requise,
  definition LIKE '%NEW.date_effet IS NULL OR NEW.date_effet <= CURRENT_DATE%' AS effet_immediat_uniquement
FROM fn;

\echo '--- Trigger raccordé (attendu: 1 ligne) ---'
SELECT t.tgname, pg_get_triggerdef(t.oid) AS definition
FROM pg_trigger t
WHERE t.tgrelid = 'public.piece_technique_versions'::regclass
  AND t.tgname = 'trg_prevent_validated_piece_version_mutation'
  AND NOT t.tgisinternal;

\echo '--- Contrôle de données non mutées par le patch ---'
SELECT
  count(*) FILTER (WHERE statut = 'APPLICABLE') AS versions_applicables,
  count(*) FILTER (WHERE statut = 'OBSOLETE') AS versions_obsoletes
FROM public.piece_technique_versions;
