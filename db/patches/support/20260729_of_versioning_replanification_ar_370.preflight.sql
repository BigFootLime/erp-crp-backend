-- Preflight — 20260729_of_versioning_replanification_ar_370.sql
-- Lecture seule. À exécuter AVANT le patch, sur la base visée.
-- Toute ligne `BLOQUANT` interdit l'application.

\echo '--- Prérequis de tables ---'
SELECT
  t.name,
  CASE WHEN to_regclass(t.name) IS NULL THEN 'BLOQUANT — absente' ELSE 'ok' END AS etat
FROM (VALUES
  ('public.ordres_fabrication'), ('public.of_operations'), ('public.of_time_logs'),
  ('public.users'), ('public.affaire'), ('public.commande_client'), ('public.clients'),
  ('public.app_roles')
) AS t(name);

\echo '--- pgcrypto (digest sha256) requis par le backfill ---'
SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgcrypto')
            THEN 'ok' ELSE 'BLOQUANT — pgcrypto absent' END AS pgcrypto;

\echo '--- Objets déjà créés par un passage antérieur ---'
SELECT t.name, CASE WHEN to_regclass(t.name) IS NULL THEN 'absent' ELSE 'déjà présent' END AS etat
FROM (VALUES
  ('public.of_revisions'), ('public.of_operation_visas'),
  ('public.of_time_variance_proposals'), ('public.of_planning_versions'),
  ('public.ar_recalage_dossiers'), ('public.notification_routing'), ('public.of_documents')
) AS t(name);

\echo '--- Volumétrie touchée par le backfill R00 ---'
SELECT
  (SELECT count(*) FROM public.ordres_fabrication) AS ofs,
  (SELECT count(*) FROM public.of_operations) AS operations,
  (SELECT count(*) FROM public.of_time_logs) AS pointages;

\echo '--- Contrainte d''unicité à remplacer sur of_operations ---'
SELECT conname, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid = 'public.of_operations'::regclass AND contype = 'u';

\echo '--- Doublons (of_id, phase) : empêcheraient la nouvelle clé ---'
SELECT of_id, phase, count(*) AS occurrences
FROM public.of_operations
GROUP BY of_id, phase
HAVING count(*) > 1;

\echo '--- Rôles attendus par l''amorçage du routage ---'
SELECT r.role_key,
       CASE WHEN a.role_key IS NULL THEN 'absent — routage partiel' ELSE 'ok' END AS etat
FROM unnest(ARRAY[
  'Planning', 'Planification', 'Responsable Atelier-Production',
  'Commerce', 'Assistante polyvalente', 'Secretaire'
]) AS r(role_key)
LEFT JOIN public.app_roles a ON a.role_key = r.role_key;
