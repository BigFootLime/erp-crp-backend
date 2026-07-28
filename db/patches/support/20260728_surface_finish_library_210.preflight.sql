-- Preflight 20260728_surface_finish_library_210 — LECTURE SEULE.
-- Confirme que le patch est bien additif, que ses pré-requis sont présents et
-- qu'il n'écrase aucune structure existante.

SELECT
  current_database()                                                   AS database,

  -- 1) Pré-requis GPAO / Articles / codification.
  to_regclass('public.gammes') IS NOT NULL                             AS req_gammes,
  to_regclass('public.piece_technique_versions') IS NOT NULL           AS req_versions,
  to_regclass('public.pieces_techniques_operations') IS NOT NULL       AS req_operations,
  to_regclass('public.pieces_techniques_achats') IS NOT NULL           AS req_achats,
  to_regclass('public.articles') IS NOT NULL                           AS req_articles,
  to_regclass('public.articles_traitement') IS NOT NULL                AS req_articles_traitement,
  to_regclass('public.article_category_ref') IS NOT NULL               AS req_category_ref,
  to_regprocedure('public.fn_next_issued_code_value(text)') IS NOT NULL AS req_code_allocator,
  (SELECT COUNT(*) FROM pg_proc WHERE proname = 'gen_random_uuid') > 0 AS req_gen_random_uuid,

  -- 2) La CAT cible existe déjà : le patch ne la crée pas.
  EXISTS (SELECT 1 FROM public.article_category_ref WHERE code = 'traitement_surface')
                                                                       AS cat_traitement_surface_present,

  -- 3) Aucune table du chantier ne doit préexister (sinon : patch déjà appliqué).
  to_regclass('public.surface_finish_families') IS NULL                AS t_families_absent,
  to_regclass('public.surface_finishes') IS NULL                       AS t_finishes_absent,
  to_regclass('public.surface_finish_revisions') IS NULL               AS t_revisions_absent,
  to_regclass('public.surface_finish_revision_documents') IS NULL      AS t_documents_absent,
  to_regclass('public.gamme_operation_finitions') IS NULL              AS t_operation_finish_absent,
  to_regclass('public.surface_finish_command_receipts') IS NULL        AS t_receipts_absent,

  -- 4) Les colonnes additives ne doivent pas préexister sous un autre sens.
  NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'articles_traitement' AND column_name = 'spec_fingerprint'
  )                                                                    AS col_fingerprint_absent,
  NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'pieces_techniques_achats' AND column_name = 'gamme_operation_id'
  )                                                                    AS col_achat_operation_absent,

  -- 5) Volumétrie AVANT : preuve de non-régression comparable au verify.
  (SELECT COUNT(*) FROM public.articles)                               AS articles_rows_before,
  (SELECT COUNT(*) FROM public.articles_traitement)                    AS articles_traitement_rows_before,
  (SELECT COUNT(*) FROM public.pieces_techniques_achats)               AS achats_rows_before,
  (SELECT COUNT(*) FROM public.pieces_techniques_achats WHERE type_achat = 'TRAITEMENT')
                                                                       AS achats_traitement_rows_before,
  (SELECT COUNT(*) FROM public.pieces_techniques_operations WHERE type_operation = 'SOUS_TRAITANCE')
                                                                       AS operations_sous_traitance_before,

  -- 6) L'anti-doublon exigera une empreinte unique : aucune donnée ne doit s'y opposer
  --    (le patch n'écrit aucune empreinte, ce compte doit donc rester à 0).
  0                                                                    AS expected_existing_fingerprints,

  -- 7) Le rôle applicatif doit exister pour que les GRANT s'appliquent.
  EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app')           AS cerp_app_role_present,

  -- 8) Le scope FIN ne doit PAS encore être accepté (preuve que l'élargissement sert).
  NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE proname = 'fn_next_issued_code_value'
      AND prosrc LIKE '%FIN|%'
  )                                                                    AS code_scope_fin_absent;
