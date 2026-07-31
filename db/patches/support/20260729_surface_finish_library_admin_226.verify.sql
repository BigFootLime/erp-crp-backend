-- Verify 20260729_surface_finish_library_admin_226 — LECTURE SEULE.
-- Toutes les colonnes booléennes doivent être `true`.
-- Les comptes doivent être IDENTIQUES au preflight : aucun backfill.

SELECT
  current_database()                                                        AS database,

  -- 1) Table des favoris et ses garde-fous.
  to_regclass('public.surface_finish_favorites') IS NOT NULL                AS t_favorites,
  EXISTS (SELECT 1 FROM pg_constraint
          WHERE conname='surface_finish_favorites_pk'
            AND conrelid='public.surface_finish_favorites'::regclass)       AS fav_pk,
  EXISTS (SELECT 1 FROM pg_constraint
          WHERE conname='surface_finish_favorites_user_fk'
            AND conrelid='public.surface_finish_favorites'::regclass
            AND confdeltype = 'c')                                          AS fav_user_fk_cascade,
  EXISTS (SELECT 1 FROM pg_constraint
          WHERE conname='surface_finish_favorites_finish_fk'
            AND conrelid='public.surface_finish_favorites'::regclass
            AND confdeltype = 'c')                                          AS fav_finish_fk_cascade,
  EXISTS (SELECT 1 FROM pg_indexes
          WHERE indexname='surface_finish_favorites_finish_idx')            AS fav_reverse_idx,

  -- 2) Colonnes d'archivage réellement posées, et NULLABLES (additif).
  EXISTS (SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='surface_finishes'
            AND column_name='archived_at' AND is_nullable='YES')            AS col_archived_at,
  EXISTS (SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='surface_finishes'
            AND column_name='archived_by' AND is_nullable='YES')            AS col_archived_by,
  EXISTS (SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='surface_finishes'
            AND column_name='archive_reason' AND is_nullable='YES')         AS col_archive_reason,
  EXISTS (SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='surface_finishes'
            AND column_name='statut_changed_at')                            AS col_statut_changed_at,
  EXISTS (SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='surface_finishes'
            AND column_name='statut_changed_by')                            AS col_statut_changed_by,

  -- 3) Cohérence d'archivage présente ET validée.
  EXISTS (SELECT 1 FROM pg_constraint
          WHERE conname='surface_finishes_archive_coherent'
            AND conrelid='public.surface_finishes'::regclass)               AS chk_archive_present,
  EXISTS (SELECT 1 FROM pg_constraint
          WHERE conname='surface_finishes_archive_coherent'
            AND conrelid='public.surface_finishes'::regclass
            AND convalidated)                                               AS chk_archive_validated,

  -- 4) Anti-doublon du référentiel : index unique ET partiel.
  EXISTS (SELECT 1 FROM pg_indexes
          WHERE indexname='surface_finishes_identity_uq')                   AS idx_identity,
  (SELECT indisunique FROM pg_index
   WHERE indexrelid='public.surface_finishes_identity_uq'::regclass)        AS idx_identity_is_unique,
  (SELECT pg_get_expr(indpred, indrelid) IS NOT NULL FROM pg_index
   WHERE indexrelid='public.surface_finishes_identity_uq'::regclass)        AS idx_identity_is_partial,
  EXISTS (SELECT 1 FROM pg_indexes
          WHERE indexname='surface_finishes_archived_at_idx')               AS idx_archived_at,

  -- 5) Le socle #210 est intact : rien n'a été retiré.
  EXISTS (SELECT 1 FROM pg_indexes
          WHERE indexname='surface_finish_revisions_single_active_uq')      AS idx_210_single_active_intact,
  EXISTS (SELECT 1 FROM pg_indexes
          WHERE indexname='articles_traitement_fingerprint_current_uq')     AS idx_210_fingerprint_intact,
  EXISTS (SELECT 1 FROM pg_constraint
          WHERE conname='surface_finishes_code_uq')                         AS uq_210_code_intact,

  -- 6) Volumétrie APRÈS : doit égaler le preflight.
  (SELECT COUNT(*) FROM public.surface_finishes)                            AS finishes_rows_after,
  (SELECT COUNT(*) FROM public.surface_finish_revisions)                    AS revisions_rows_after,
  (SELECT COUNT(*) FROM public.surface_finish_families)                     AS families_rows_after,
  (SELECT COUNT(*) FROM public.gamme_operation_finitions)                   AS requirements_rows_after,
  (SELECT COUNT(*) FROM public.articles)                                    AS articles_rows_after,
  (SELECT COUNT(*) FROM public.surface_finish_favorites)                    AS favorites_rows;

-- 7) Ownership : les nouvelles tables doivent appartenir à cerp_app, sinon
--    l'API tombera en 42501 → 500 (leçon prod du 2026-07-21).
SELECT tablename, tableowner
FROM pg_tables
WHERE schemaname = 'public' AND tablename = 'surface_finish_favorites';
