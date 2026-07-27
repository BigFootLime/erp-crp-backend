-- Verify 20260727_ged_core — LECTURE SEULE.
-- Toutes les colonnes doivent être `true` (ou le compte attendu) après application.

SELECT
  current_database() AS database,

  -- 1) Les 13 tables du noyau existent.
  to_regclass('public.ged_document_classes') IS NOT NULL          AS t_classes,
  to_regclass('public.ged_blobs') IS NOT NULL                      AS t_blobs,
  to_regclass('public.ged_documents') IS NOT NULL                  AS t_documents,
  to_regclass('public.ged_document_versions') IS NOT NULL          AS t_versions,
  to_regclass('public.ged_document_links') IS NOT NULL             AS t_links,
  to_regclass('public.ged_document_relations') IS NOT NULL         AS t_relations,
  to_regclass('public.ged_approvals') IS NOT NULL                  AS t_approvals,
  to_regclass('public.ged_checkouts') IS NOT NULL                  AS t_checkouts,
  to_regclass('public.ged_retention_holds') IS NOT NULL            AS t_holds,
  to_regclass('public.ged_snapshot_manifests') IS NOT NULL         AS t_manifests,
  to_regclass('public.ged_snapshot_manifest_entries') IS NOT NULL  AS t_manifest_entries,
  to_regclass('public.ged_upload_sessions') IS NOT NULL            AS t_upload_sessions,
  to_regclass('public.ged_access_events') IS NOT NULL              AS t_access_events,

  -- 2) Le référentiel de classes est amorcé.
  (SELECT COUNT(*) FROM public.ged_document_classes WHERE is_active) AS active_classes,

  -- 3) Les garde-fous structurels sont en place.
  EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_ged_version_immutable')            AS trg_version_immutable,
  EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_ged_version_separation_of_duties') AS trg_separation_of_duties,
  EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_ged_manifest_immutable')           AS trg_manifest_immutable,
  EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_ged_access_events_append_only')    AS trg_audit_append_only,
  EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_ged_document_hold_guard')          AS trg_hold_guard,
  EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_ged_blob_immutable')               AS trg_blob_immutable,
  EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'uq_ged_versions_single_applicable') AS idx_single_applicable,
  EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'uq_ged_checkout_active')            AS idx_single_checkout,

  -- 4) Droits du rôle applicatif : présents, et journal non modifiable.
  (
    NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app')
    OR (
      has_table_privilege('cerp_app', 'public.ged_documents', 'SELECT,INSERT,UPDATE')
      AND has_table_privilege('cerp_app', 'public.ged_document_versions', 'SELECT,INSERT,UPDATE')
      AND has_table_privilege('cerp_app', 'public.ged_blobs', 'SELECT,INSERT')
      AND has_table_privilege('cerp_app', 'public.ged_access_events', 'SELECT,INSERT')
      AND NOT has_table_privilege('cerp_app', 'public.ged_access_events', 'UPDATE')
      AND NOT has_table_privilege('cerp_app', 'public.ged_access_events', 'DELETE')
      AND NOT has_table_privilege('cerp_app', 'public.ged_snapshot_manifests', 'UPDATE')
      AND NOT has_table_privilege('cerp_app', 'public.ged_snapshot_manifests', 'DELETE')
    )
  ) AS grants_ok,

  -- 5) NON-RÉGRESSION : les mini-GED historiques sont intactes et non vidées.
  to_regclass('public.pieces_techniques_documents') IS NOT NULL AS legacy_pt_docs_present,
  to_regclass('public.quality_documents') IS NOT NULL           AS legacy_quality_docs_present,
  to_regclass('public.project_evidence_files') IS NOT NULL      AS legacy_po_files_present,
  to_regclass('public.of_technical_snapshots') IS NOT NULL      AS legacy_of_snapshots_present,
  (SELECT COUNT(*) FROM public.pieces_techniques_documents)     AS legacy_pt_docs_rows,
  (SELECT COUNT(*) FROM public.quality_documents)               AS legacy_quality_docs_rows,

  -- 6) Aucune colonne n'a été ajoutée aux tables historiques par ce patch.
  NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name IN ('pieces_techniques_documents', 'quality_documents', 'stock_documents',
                         'fournisseur_documents', 'metrologie_certificats', 'project_evidence_files')
      AND column_name = 'ged_document_version_id'
  ) AS legacy_tables_untouched;
