/** Plan references are frozen in the OF, never read from the latest PT file. */
export function frozenStationPlansSql(ofAlias: "b" | "c") {
  return `
    SELECT dv.id::text AS id, d.title AS label, dv.original_name,
           blob.mime_type, blob.size_bytes, blob.sha256,
           ${ofAlias}.piece_technique_version_id::text AS piece_technique_version_id,
           frozen.position
      FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(${ofAlias}.technical_snapshot->'documents') = 'array'
             THEN ${ofAlias}.technical_snapshot->'documents' ELSE '[]'::jsonb END
      ) WITH ORDINALITY AS frozen(document, position)
      JOIN public.ged_document_versions dv ON dv.id::text = frozen.document->>'version_id'
      JOIN public.ged_documents d ON d.id = dv.document_id AND d.id::text = frozen.document->>'id'
      JOIN public.ged_blobs blob ON blob.id = dv.blob_id AND blob.sha256 = frozen.document->>'sha256'
      JOIN public.ged_upload_sessions scan ON scan.id = dv.upload_session_id
       AND scan.scan_status = 'clean' AND scan.quarantine_status = 'released'
     WHERE frozen.document->>'role' = 'PLAN_CLIENT'
       AND ${ofAlias}.piece_technique_version_id IS NOT NULL
       AND ${ofAlias}.technical_snapshot_sha256 IS NOT NULL
       AND dv.status IN ('APPLICABLE', 'OBSOLETE')
       AND EXISTS (
         SELECT 1 FROM public.ged_document_links link
          WHERE link.document_id = d.id AND link.entity_type = 'PIECE_TECHNIQUE_VERSION'
            AND link.entity_id = ${ofAlias}.piece_technique_version_id::text
            AND link.link_role = 'PLAN_CLIENT'
       )
  `;
}
