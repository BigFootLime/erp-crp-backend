// The dossier and OF preparation recognise the same revision-bound, published
// and scan-released customer plans. Legacy files remain archives to reimport.
export const CANONICAL_PIECE_PLANS_SQL = `
  SELECT DISTINCT d.id::text AS id, v.original_name, b.mime_type,
         b.size_bytes::text AS size_bytes, 'PLAN'::text AS document_type_code,
         pv.id::text AS piece_technique_version_id,
         v.created_at::text AS created_at, NULL::text AS removed_at,
         'GED'::text AS content_source, v.id::text AS ged_version_id
    FROM public.ged_documents d
    JOIN public.ged_document_versions v ON v.id = d.current_version_id AND v.status = 'APPLICABLE'
    JOIN public.ged_blobs b ON b.id = v.blob_id
    JOIN public.ged_upload_sessions s ON s.id = v.upload_session_id
    JOIN public.ged_document_links l ON l.document_id = d.id
    JOIN public.piece_technique_versions pv ON pv.id::text = l.entity_id
   WHERE pv.piece_technique_id = $1::uuid
     AND l.entity_type = 'PIECE_TECHNIQUE_VERSION'
     AND l.link_role IN ('PLAN_CLIENT', 'PLAN', 'TECHNICAL_DRAWING')
     AND d.class_key = 'PLAN_CLIENT' AND d.archived_at IS NULL
     AND s.scan_status = 'clean' AND s.quarantine_status = 'released'
   ORDER BY created_at DESC, id DESC
`;
