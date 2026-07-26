-- Préflight du correctif bloquant #227 découvert pendant #275.
-- LECTURE SEULE : confirme la fonction, les cinq triggers et indique si la
-- garde imbriquée sûre est déjà installée.

\echo '=== #227 trigger fix preflight — base cible ==='
SELECT current_database() AS database, current_user AS role, now() AS checked_at;

\echo '--- Fonction attendue ---'
SELECT
  count(*) = 1 AS function_present,
  coalesce(bool_or(
    position(
      'IF TG_TABLE_NAME = ''facture_echeance'' AND TG_OP = ''UPDATE'' THEN'
      IN p.prosrc
    ) > 0
  ), false) AS nested_guard_already_present
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname = 'fn_protect_facturation_child_227';

\echo '--- Triggers raccordés à la fonction (5 attendus) ---'
SELECT c.relname AS table_name, t.tgname
FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_proc p ON p.oid = t.tgfoid
WHERE n.nspname = 'public'
  AND NOT t.tgisinternal
  AND p.proname = 'fn_protect_facturation_child_227'
ORDER BY c.relname, t.tgname;

\echo '--- Tables requises ---'
SELECT relation,
       to_regclass('public.' || relation) IS NOT NULL AS present
FROM unnest(ARRAY[
  'facture',
  'facture_ligne',
  'facture_echeance',
  'avoir_ligne',
  'facture_source_allocations',
  'avoir_source_allocations'
]) AS relation
ORDER BY relation;

\echo '=== #227 trigger fix preflight terminé ==='
