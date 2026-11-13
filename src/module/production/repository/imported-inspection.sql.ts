/** Exact approved bytes from the frozen definition; revocation and quarantine still block execution. */
export const IMPORTED_INSPECTION_EVIDENCE_SQL = `EXISTS(
  SELECT 1 FROM jsonb_array_elements(COALESCE(o.technical_snapshot->'preparation_evidence'->'documents','[]')) evidence
  JOIN public.ged_document_versions iv ON iv.id::text=evidence->>'version_id' AND iv.status='APPLICABLE'
  JOIN public.ged_documents idoc ON idoc.id=iv.document_id AND idoc.id::text=evidence->>'id' AND idoc.archived_at IS NULL
  JOIN public.ged_blobs ib ON ib.id=iv.blob_id AND ib.sha256=evidence->>'sha256'
  JOIN public.ged_upload_sessions iu ON iu.id=iv.upload_session_id AND iu.scan_status='clean' AND iu.quarantine_status='released'
  WHERE evidence->>'role'='FICHE_AUTOCONTROLE' AND o.preparation_rules_version>=2
    AND EXISTS(SELECT 1 FROM public.ged_document_links il WHERE il.document_id=idoc.id
      AND ((il.entity_type='PIECE_TECHNIQUE_VERSION' AND il.entity_id=o.piece_technique_version_id::text AND il.link_role='FICHE_AUTOCONTROLE')
        OR (il.entity_type='PIECE_TECHNIQUE' AND il.entity_id=o.piece_technique_id::text AND il.link_role='DOSSIER_TECHNIQUE'))))`;
