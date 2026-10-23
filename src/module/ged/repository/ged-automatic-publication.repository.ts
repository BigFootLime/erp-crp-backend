import type { PoolClient } from "pg";

export type AutomaticPublicationSource = {
  document_id: string;
  version_id: string;
  status: string;
  archived: boolean;
  held: boolean;
  checked_out_by_other: boolean;
  scan_status: string | null;
  quarantine_status: string | null;
  scan_matches_blob: boolean;
  links: Array<{ entity_type: string; entity_id: string }>;
};

/** The durable scan must describe these exact bytes, not another upload session. */
export async function repoLockAutomaticPublicationSource(
  tx: Pick<PoolClient, "query">,
  documentId: string,
  versionId: string,
  actorId: number,
): Promise<AutomaticPublicationSource | null> {
  const result = await tx.query<AutomaticPublicationSource>(
    `SELECT d.id::text AS document_id, v.id::text AS version_id, v.status,
       (d.archived_at IS NOT NULL) AS archived,
       EXISTS (SELECT 1 FROM public.ged_retention_holds h
         WHERE h.document_id=d.id AND h.released_at IS NULL) AS held,
       EXISTS (SELECT 1 FROM public.ged_checkouts k
         WHERE k.document_id=d.id AND k.released_at IS NULL AND k.held_by<>$3) AS checked_out_by_other,
       s.scan_status, s.quarantine_status,
       COALESCE(s.document_id=d.id AND s.sha256=b.sha256
         AND s.mime_type=b.mime_type AND s.size_bytes=b.size_bytes, false) AS scan_matches_blob,
       COALESCE((SELECT json_agg(json_build_object('entity_type',l.entity_type,'entity_id',l.entity_id))
         FROM public.ged_document_links l WHERE l.document_id=d.id), '[]'::json) AS links
     FROM public.ged_document_versions v
     JOIN public.ged_documents d ON d.id=v.document_id
     JOIN public.ged_blobs b ON b.id=v.blob_id
     LEFT JOIN public.ged_upload_sessions s ON s.id=v.upload_session_id
     WHERE d.id=$1::uuid AND v.id=$2::uuid
     FOR UPDATE OF d,v`,
    [documentId, versionId, actorId],
  );
  return result?.rows?.[0] ?? null;
}
