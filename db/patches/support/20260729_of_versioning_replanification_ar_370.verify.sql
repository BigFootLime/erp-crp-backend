-- Verify — 20260729_of_versioning_replanification_ar_370.sql
-- Lecture seule. À exécuter APRÈS le patch. Toute ligne `ECHEC` invalide l'application.

\echo '--- Tables créées ---'
SELECT t.name, CASE WHEN to_regclass(t.name) IS NULL THEN 'ECHEC — absente' ELSE 'ok' END AS etat
FROM (VALUES
  ('public.of_revisions'), ('public.of_operation_visas'),
  ('public.of_time_variance_proposals'), ('public.of_planning_versions'),
  ('public.ar_recalage_dossiers'), ('public.notification_routing'), ('public.of_documents')
) AS t(name);

\echo '--- Unicité of_operations : doit être (of_id, revision_id, phase) ---'
SELECT
  CASE
    WHEN EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'public.of_operations'::regclass
        AND conname = 'of_operations_of_revision_phase_key'
    ) AND NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'public.of_operations'::regclass
        AND conname = 'of_operations_of_id_phase_key'
    ) THEN 'ok'
    ELSE 'ECHEC — clé d''unicité non basculée'
  END AS etat;

\echo '--- Backfill R00 : chaque OF a exactement une révision ACTIVE ---'
SELECT
  CASE WHEN count(*) = 0 THEN 'ok'
       ELSE 'ECHEC — ' || count(*) || ' OF sans révision ACTIVE unique' END AS etat
FROM (
  SELECT o.id
  FROM public.ordres_fabrication o
  LEFT JOIN public.of_revisions r ON r.of_id = o.id AND r.statut = 'ACTIVE'
  GROUP BY o.id
  HAVING count(r.id) <> 1
) AS anomalies;

\echo '--- Opérations rattachées à une révision ---'
SELECT
  CASE WHEN count(*) = 0 THEN 'ok'
       ELSE 'ATTENTION — ' || count(*) || ' opération(s) sans révision' END AS etat
FROM public.of_operations WHERE revision_id IS NULL;

\echo '--- Triggers d''immuabilité ---'
SELECT t.name, CASE WHEN EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = t.name AND NOT tgisinternal
  ) THEN 'ok' ELSE 'ECHEC — absent' END AS etat
FROM (VALUES
  ('trg_of_revisions_immutable'),
  ('trg_of_operations_obsolete_revision_readonly'),
  ('trg_of_operation_visas_append_only'),
  ('trg_of_documents_immutable')
) AS t(name);

\echo '--- Index d''unicité métier ---'
SELECT i.name, CASE WHEN to_regclass(i.name) IS NULL THEN 'ECHEC — absent' ELSE 'ok' END AS etat
FROM (VALUES
  ('public.of_revisions_active_uq'),
  ('public.of_planning_versions_active_uq'),
  ('public.of_planning_versions_open_draft_uq'),
  ('public.of_documents_official_uq'),
  ('public.of_operation_visas_live_uq')
) AS i(name);

\echo '--- Routage de notification : par rôle, aucune identité en dur ---'
SELECT topic, count(*) FILTER (WHERE role_key IS NOT NULL) AS cibles_role,
       count(*) FILTER (WHERE user_id IS NOT NULL) AS cibles_identite
FROM public.notification_routing
GROUP BY topic ORDER BY topic;

\echo '--- Motif AUTRE : le commentaire est exigé ---'
SELECT CASE WHEN EXISTS (
  SELECT 1 FROM pg_constraint
  WHERE conrelid = 'public.ar_recalage_dossiers'::regclass
    AND conname = 'ar_recalage_autre_comment_ck'
) THEN 'ok' ELSE 'ECHEC — contrainte absente' END AS etat;

\echo '--- F) Référentiel des familles machine : les 5 codes attendus ---'
SELECT f.code,
       CASE WHEN EXISTS (SELECT 1 FROM public.production_machine_families m WHERE m.code = f.code)
            THEN 'ok' ELSE 'ECHEC — famille absente' END AS etat
FROM (VALUES ('T'), ('F'), ('TTRAD'), ('FTRAD'), ('DECOUPE')) AS f(code);

\echo '--- F) Colonnes de gamme normalisée figées sur of_operations ---'
SELECT c.name,
       CASE WHEN EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'of_operations' AND column_name = c.name
       ) THEN 'ok' ELSE 'ECHEC — colonne absente' END AS etat
FROM (VALUES
  ('numero_programme'), ('machine_family_code'), ('cf_code_snapshot'),
  ('cf_rate_id'), ('temps_fabrication_planned'), ('hourly_rate_source'),
  ('hourly_rate_effective_at'), ('revision_id')
) AS c(name);

\echo '--- F) Index famille + contrainte n° de programme non vide ---'
SELECT
  CASE WHEN to_regclass('public.of_operations_family_idx') IS NULL
       THEN 'ECHEC — index famille absent' ELSE 'ok' END AS index_famille,
  CASE WHEN EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.of_operations'::regclass AND conname = 'of_operations_programme_ck'
  ) THEN 'ok' ELSE 'ECHEC — contrainte programme absente' END AS contrainte_programme;

\echo '--- G) Propriété applicative : cerp_app doit posséder les 7 tables ---'
SELECT c.relname,
       pg_get_userbyid(c.relowner) AS proprietaire,
       CASE WHEN pg_get_userbyid(c.relowner) = 'cerp_app' THEN 'ok'
            ELSE 'ECHEC — cerp_app recevra 42501 (endpoint en 500)' END AS etat
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
WHERE c.relname IN (
  'of_revisions', 'of_operation_visas', 'of_time_variance_proposals',
  'of_planning_versions', 'ar_recalage_dossiers', 'notification_routing', 'of_documents'
)
ORDER BY c.relname;

\echo '--- Registre de migrations — ce patch ---'
SELECT CASE WHEN EXISTS (
  SELECT 1 FROM public.cerp_schema_migrations
  WHERE filename = '20260729_of_versioning_replanification_ar_370.sql'
) THEN 'ok' ELSE 'ECHEC — non enregistré' END AS etat;

-- Signalement, pas un échec de CE patch : `20260729_methodes_gamme_referentials.sql`
-- a été EXÉCUTÉ sur les deux bases (les objets de la section F le prouvent) sans
-- être enregistré. Le registre ment dans le sens dangereux : il fait croire qu'il
-- reste à passer. Un runner qui le rejouerait buterait sur ses commandes non
-- gardées. La correction appartient au chantier Méthodes, pas à celui-ci.
\echo '--- Signalement : dérive de registre héritée (hors périmètre #370) ---'
SELECT
  CASE WHEN to_regclass('public.production_machine_families') IS NOT NULL
       THEN 'objets présents' ELSE 'objets absents' END AS realite_schema,
  CASE WHEN EXISTS (
    SELECT 1 FROM public.cerp_schema_migrations
    WHERE filename = '20260729_methodes_gamme_referentials.sql'
  ) THEN 'enregistré' ELSE 'NON enregistré — à arbitrer par le chantier Méthodes' END AS registre;
