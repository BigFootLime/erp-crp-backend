import type { PoolClient } from "pg";

type ImprovementReturn = {
  version_id: string;
  title: string;
  original_name: string;
  mime_type: string;
};

/** Returns belong to the piece across subsequent OFs and internal revisions.
 * They remain live feedback, separate from the frozen manufacturing evidence. */
export async function readImprovementReturns(tx: Pick<PoolClient, "query">, ofId: number) {
  const { rows } = await tx.query<ImprovementReturn>(`
    SELECT v.id::text AS version_id, d.title, v.original_name, b.mime_type
    FROM public.ged_document_links l
    JOIN public.ged_documents d ON d.id=l.document_id AND d.archived_at IS NULL
    JOIN public.ged_document_versions v ON v.id=d.current_version_id AND v.status='APPLICABLE'
    JOIN public.ged_blobs b ON b.id=v.blob_id
    JOIN public.ged_upload_sessions s ON s.id=v.upload_session_id AND s.scan_status='clean' AND s.quarantine_status='released'
    WHERE l.entity_type='PIECE_TECHNIQUE' AND l.entity_id=(SELECT piece_technique_id::text FROM public.ordres_fabrication WHERE id=$1) AND l.link_role='FICHE_AMELIORATION'
    ORDER BY v.created_at DESC, v.id DESC`, [ofId]);
  return rows;
}
