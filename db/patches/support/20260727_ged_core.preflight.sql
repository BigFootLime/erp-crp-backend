-- Preflight 20260727_ged_core — LECTURE SEULE.
-- Confirme que le patch est bien additif et qu'aucune table GED ne préexiste.

SELECT
  current_database()                                            AS database,
  to_regclass('public.users') IS NOT NULL                       AS users_present,

  -- Aucune table du noyau ne doit préexister (sinon : patch déjà appliqué).
  to_regclass('public.ged_documents') IS NULL                   AS ged_documents_absent,
  to_regclass('public.ged_document_versions') IS NULL            AS ged_versions_absent,
  to_regclass('public.ged_blobs') IS NULL                        AS ged_blobs_absent,
  to_regclass('public.ged_access_events') IS NULL                AS ged_audit_absent,

  -- Preuve de non-régression : les mini-GED historiques restent intactes.
  to_regclass('public.pieces_techniques_documents') IS NOT NULL  AS legacy_pt_docs_present,
  to_regclass('public.quality_documents') IS NOT NULL            AS legacy_quality_docs_present,
  to_regclass('public.project_evidence_files') IS NOT NULL       AS legacy_po_files_present,
  (SELECT COUNT(*) FROM public.pieces_techniques_documents)      AS legacy_pt_docs_rows,
  (SELECT COUNT(*) FROM public.quality_documents)                AS legacy_quality_docs_rows,

  -- Le rôle applicatif doit exister pour que les GRANT s'appliquent.
  EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app')     AS cerp_app_role_present,

  -- gen_random_uuid() est requis (pgcrypto ou PostgreSQL >= 13 natif).
  (SELECT COUNT(*) FROM pg_proc WHERE proname = 'gen_random_uuid') > 0 AS gen_random_uuid_available;
