-- Rollback 20260727_ged_core.
--
-- Sûr tant qu'aucun document réel n'a été déposé : le patch étant strictement
-- additif, retirer ses tables ne touche AUCUNE donnée existante de l'ERP.
--
-- ARRÊT OBLIGATOIRE si des documents ont été déposés : les blobs correspondants
-- vivent dans le coffre et seraient orphelins. Dans ce cas, ne pas exécuter ce
-- script — restaurer le couple base + volume depuis la sauvegarde.

DO $guard$
DECLARE
  doc_count integer := 0;
BEGIN
  IF to_regclass('public.ged_documents') IS NOT NULL THEN
    EXECUTE 'SELECT COUNT(*) FROM public.ged_documents' INTO doc_count;
    IF doc_count > 0 THEN
      RAISE EXCEPTION
        'ROLLBACK REFUSÉ : % document(s) présent(s) dans la GED. Des blobs existent dans le coffre. Restaurer base + volume depuis la sauvegarde au lieu de supprimer les tables.',
        doc_count;
    END IF;
  END IF;
END
$guard$;

BEGIN;

DROP TABLE IF EXISTS public.ged_snapshot_manifest_entries CASCADE;
DROP TABLE IF EXISTS public.ged_snapshot_manifests CASCADE;
DROP TABLE IF EXISTS public.ged_access_events CASCADE;
DROP TABLE IF EXISTS public.ged_upload_sessions CASCADE;
DROP TABLE IF EXISTS public.ged_retention_holds CASCADE;
DROP TABLE IF EXISTS public.ged_checkouts CASCADE;
DROP TABLE IF EXISTS public.ged_approvals CASCADE;
DROP TABLE IF EXISTS public.ged_document_relations CASCADE;
DROP TABLE IF EXISTS public.ged_document_links CASCADE;

ALTER TABLE IF EXISTS public.ged_documents DROP CONSTRAINT IF EXISTS ged_documents_current_version_fkey;
DROP TABLE IF EXISTS public.ged_document_versions CASCADE;
DROP TABLE IF EXISTS public.ged_documents CASCADE;
DROP TABLE IF EXISTS public.ged_blobs CASCADE;
DROP TABLE IF EXISTS public.ged_document_classes CASCADE;

DROP FUNCTION IF EXISTS public.fn_ged_blob_immutable();
DROP FUNCTION IF EXISTS public.fn_ged_document_code_immutable();
DROP FUNCTION IF EXISTS public.fn_ged_version_immutable();
DROP FUNCTION IF EXISTS public.fn_ged_version_separation_of_duties();
DROP FUNCTION IF EXISTS public.fn_ged_document_hold_guard();
DROP FUNCTION IF EXISTS public.fn_ged_manifest_immutable();
DROP FUNCTION IF EXISTS public.fn_ged_access_events_append_only();

COMMIT;
