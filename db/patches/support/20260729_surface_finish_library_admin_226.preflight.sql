-- Preflight 20260729_surface_finish_library_admin_226 — LECTURE SEULE.
-- Confirme que les pré-requis sont là, que rien du patch ne préexiste, et
-- surtout que l'index d'identité PEUT être créé sans conflit.

SELECT
  current_database()                                                        AS database,

  -- 1) Pré-requis : le socle #210 doit être en place.
  to_regclass('public.surface_finishes') IS NOT NULL                        AS req_finishes,
  to_regclass('public.surface_finish_revisions') IS NOT NULL                AS req_revisions,
  to_regclass('public.users') IS NOT NULL                                   AS req_users,
  to_regprocedure('public.surface_finish_norm(text)') IS NOT NULL           AS req_norm_fn,

  -- 2) Rien du patch ne doit préexister (sinon : déjà appliqué).
  to_regclass('public.surface_finish_favorites') IS NULL                    AS t_favorites_absent,
  NOT EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='surface_finishes'
                AND column_name='archived_at')                              AS col_archived_at_absent,
  NOT EXISTS (SELECT 1 FROM pg_indexes
              WHERE indexname='surface_finishes_identity_uq')               AS idx_identity_absent,

  -- 3) LE point de rupture possible. L'index unique partiel échouerait si des
  --    doublons stricts existaient déjà. On les compte AVANT d'écrire.
  --    Attendu : 0. Si > 0, NE PAS APPLIQUER : il faut d'abord arbitrer avec
  --    le métier lesquels archiver (la requête 4 les liste).
  (SELECT COUNT(*) FROM (
     SELECT 1
     FROM public.surface_finishes
     WHERE statut <> 'ARCHIVEE'
     GROUP BY family_code,
              public.surface_finish_norm(procede),
              public.surface_finish_norm(designation_courte)
     HAVING COUNT(*) > 1
   ) d)                                                                     AS identity_conflicts,

  -- 4) Lignes déjà ARCHIVEE. Avant ce patch la colonne `archive_reason`
  --    n'existe pas : toute ligne ARCHIVEE est donc SANS motif et laisserait
  --    `surface_finishes_archive_coherent` en NOT VALID. Attendu : 0 (aucun
  --    chemin d'archivage n'existait). Ne pas référencer `archive_reason` ici,
  --    un preflight s'exécute AVANT le patch.
  (SELECT COUNT(*) FROM public.surface_finishes WHERE statut = 'ARCHIVEE')  AS archived_rows_without_reason,

  -- 5) Volumétrie AVANT : à comparer au verify, doit être IDENTIQUE.
  (SELECT COUNT(*) FROM public.surface_finishes)                            AS finishes_rows_before,
  (SELECT COUNT(*) FROM public.surface_finish_revisions)                    AS revisions_rows_before,
  (SELECT COUNT(*) FROM public.surface_finish_families)                     AS families_rows_before,
  (SELECT COUNT(*) FROM public.gamme_operation_finitions)                   AS requirements_rows_before,
  (SELECT COUNT(*) FROM public.articles)                                    AS articles_rows_before;

-- Détail des conflits d'identité éventuels (vide = feu vert).
SELECT
  family_code,
  public.surface_finish_norm(procede)            AS procede_norm,
  public.surface_finish_norm(designation_courte) AS designation_norm,
  COUNT(*)                                       AS occurrences,
  array_agg(code ORDER BY created_at)            AS codes
FROM public.surface_finishes
WHERE statut <> 'ARCHIVEE'
GROUP BY 1, 2, 3
HAVING COUNT(*) > 1
ORDER BY occurrences DESC, 1, 2, 3;
