-- Verify 20260728_surface_finish_library_210 — LECTURE SEULE.
-- Toutes les colonnes booléennes doivent être `true` après application.
-- Les comptes sont à comparer au preflight : ils doivent être IDENTIQUES
-- (le patch n'écrit aucune donnée métier, il n'y a aucun backfill).

SELECT
  current_database()                                                        AS database,

  -- 1) Les 6 tables du chantier existent.
  to_regclass('public.surface_finish_families') IS NOT NULL                 AS t_families,
  to_regclass('public.surface_finishes') IS NOT NULL                        AS t_finishes,
  to_regclass('public.surface_finish_revisions') IS NOT NULL                AS t_revisions,
  to_regclass('public.surface_finish_revision_documents') IS NOT NULL       AS t_documents,
  to_regclass('public.gamme_operation_finitions') IS NOT NULL               AS t_operation_finish,
  to_regclass('public.surface_finish_command_receipts') IS NOT NULL         AS t_receipts,

  -- 2) Le référentiel de familles est amorcé et administrable.
  (SELECT COUNT(*) FROM public.surface_finish_families WHERE is_active)     AS active_families,

  -- 3) Colonnes additives réellement posées.
  EXISTS (SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='articles_traitement'
            AND column_name='spec_fingerprint')                             AS col_at_fingerprint,
  EXISTS (SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='articles_traitement'
            AND column_name='spec_canonical')                               AS col_at_spec,
  EXISTS (SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='articles_traitement'
            AND column_name='superseded_at')                                AS col_at_superseded,
  EXISTS (SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='pieces_techniques_achats'
            AND column_name='gamme_operation_id')                           AS col_achat_operation,
  EXISTS (SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='pieces_techniques_achats'
            AND column_name='piece_technique_version_id')                   AS col_achat_version,

  -- 4) Garde-fous structurels : anti-doublon, unicité, immuabilité.
  EXISTS (SELECT 1 FROM pg_indexes
          WHERE indexname = 'articles_traitement_fingerprint_current_uq')   AS idx_fingerprint_unique,
  EXISTS (SELECT 1 FROM pg_indexes
          WHERE indexname = 'pt_achats_gamme_operation_traitement_uq')      AS idx_achat_operation_unique,
  EXISTS (SELECT 1 FROM pg_indexes
          WHERE indexname = 'surface_finish_revisions_single_active_uq')    AS idx_single_active_revision,
  EXISTS (SELECT 1 FROM pg_constraint
          WHERE conname = 'gamme_operation_finitions_operation_uq')         AS uq_one_finish_per_operation,
  EXISTS (SELECT 1 FROM pg_trigger
          WHERE tgname = 'trg_surface_finish_code_immutable')               AS trg_code_immutable,
  EXISTS (SELECT 1 FROM pg_constraint
          WHERE conname = 'surface_finishes_code_format')                   AS chk_code_format,
  EXISTS (SELECT 1 FROM pg_constraint
          WHERE conname = 'surface_finish_revisions_epaisseur_coherente')   AS chk_thickness_range,
  EXISTS (SELECT 1 FROM pg_constraint
          WHERE conname = 'surface_finish_revisions_certificat_coherent')   AS chk_certificate_typed,
  EXISTS (SELECT 1 FROM pg_constraint
          WHERE conname = 'gamme_operation_finitions_zones_coherentes')     AS chk_zones_required,
  EXISTS (SELECT 1 FROM pg_constraint
          WHERE conname = 'articles_traitement_spec_pair_check')            AS chk_spec_pair,

  -- 5) Liaisons par clé étrangère (jamais par le numéro de phase).
  EXISTS (SELECT 1 FROM pg_constraint
          WHERE conname = 'pt_achats_gamme_operation_fk')                   AS fk_achat_operation,
  EXISTS (SELECT 1 FROM pg_constraint
          WHERE conname = 'gamme_operation_finitions_operation_fk')         AS fk_finish_operation,
  EXISTS (SELECT 1 FROM pg_constraint
          WHERE conname = 'gamme_operation_finitions_revision_fk')          AS fk_finish_revision,
  EXISTS (SELECT 1 FROM pg_constraint
          WHERE conname = 'gamme_operation_finitions_article_fk')           AS fk_finish_article,

  -- 6) Le scope de codification FIN est accepté, et aucun scope existant n'a été
  --    retiré (régression déjà vue en 20260725 : MCH avait disparu du whitelist).
  --    Lecture du corps de la fonction — on ne CONSOMME pas la séquence ici.
  EXISTS (SELECT 1 FROM pg_proc WHERE proname='fn_next_issued_code_value' AND prosrc LIKE '%FIN|%')  AS code_scope_fin,
  EXISTS (SELECT 1 FROM pg_proc WHERE proname='fn_next_issued_code_value' AND prosrc LIKE '%MCH|%')  AS code_scope_mch_kept,
  EXISTS (SELECT 1 FROM pg_proc WHERE proname='fn_next_issued_code_value' AND prosrc LIKE '%MET|%')  AS code_scope_met_kept,
  EXISTS (SELECT 1 FROM pg_proc WHERE proname='fn_next_issued_code_value' AND prosrc LIKE '%MEX|MIA%') AS code_scope_metrology_kept,

  -- 7) Droits : reçus d'idempotence non modifiables par l'application.
  (
    NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app')
    OR (
      has_table_privilege('cerp_app', 'public.surface_finishes', 'SELECT,INSERT,UPDATE')
      AND has_table_privilege('cerp_app', 'public.surface_finish_revisions', 'SELECT,INSERT,UPDATE')
      AND has_table_privilege('cerp_app', 'public.gamme_operation_finitions', 'SELECT,INSERT,UPDATE,DELETE')
      AND has_table_privilege('cerp_app', 'public.surface_finish_command_receipts', 'SELECT,INSERT')
      AND NOT has_table_privilege('cerp_app', 'public.surface_finish_command_receipts', 'UPDATE')
      AND NOT has_table_privilege('cerp_app', 'public.surface_finish_command_receipts', 'DELETE')
    )
  )                                                                         AS grants_ok,

  -- 8) NON-RÉGRESSION : aucun backfill, aucune donnée touchée.
  (SELECT COUNT(*) FROM public.articles)                                    AS articles_rows_after,
  (SELECT COUNT(*) FROM public.articles_traitement)                         AS articles_traitement_rows_after,
  (SELECT COUNT(*) FROM public.pieces_techniques_achats)                    AS achats_rows_after,
  (SELECT COUNT(*) FROM public.pieces_techniques_achats WHERE type_achat = 'TRAITEMENT')
                                                                            AS achats_traitement_rows_after,
  (SELECT COUNT(*) FROM public.articles_traitement WHERE spec_fingerprint IS NOT NULL)
                                                                            AS backfilled_fingerprints,
  (SELECT COUNT(*) FROM public.pieces_techniques_achats WHERE gamme_operation_id IS NOT NULL)
                                                                            AS backfilled_achat_links,
  (SELECT COUNT(*) FROM public.gamme_operation_finitions)                   AS finish_requirements_rows,

  -- 9) L'enum du catalogue fournisseur n'a PAS été modifié par ce patch.
  NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relname = 'fournisseur_catalogue'
      AND pg_get_constraintdef(c.oid) ILIKE '%TRAITEMENT%'
  )                                                                         AS supplier_catalogue_enum_untouched;
