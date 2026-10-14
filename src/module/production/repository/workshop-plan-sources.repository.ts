import type { DbQueryer } from "./of-versioning.repository";
import type { WorkshopFrozenPlan } from "../domain/workshop-pack-documents";

export type WorkshopPlanSource = {
  document_id: string;
  version_id: string;
  role: "PLAN_CLIENT" | "PLAN_FABRICATION";
  label: string;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  /** Private GED key: never serialize this repository row to HTTP. */
  storage_key: string;
};

/** The caller supplies references from the OF's frozen technical definition,
 * not arbitrary request UUIDs. Ownership, exact bytes and clean source status
 * are checked again here, including old pinned but now obsolete versions. */
export async function readWorkshopPlanSources(
  tx: DbQueryer,
  technicalVersionId: string,
  references: readonly WorkshopFrozenPlan[],
): Promise<WorkshopPlanSource[]> {
  if (!references.length) return [];
  const rows = references.map((ref, index) => ({ ...ref, link_role: ref.source_role ?? ref.role, position: index }));
  const result = await tx.query<WorkshopPlanSource>(`
    SELECT document.id::text AS document_id, version.id::text AS version_id, frozen.role,
           document.title AS label, version.original_name, blob.mime_type,
           blob.size_bytes::bigint::float8 AS size_bytes, blob.sha256, blob.storage_key
      FROM jsonb_to_recordset($2::jsonb)
        AS frozen(id uuid,version_id uuid,role text,link_role text,sha256 text,position integer)
      JOIN public.ged_documents document ON document.id=frozen.id
      JOIN public.ged_document_versions version ON version.id=frozen.version_id AND version.document_id=document.id
      JOIN public.ged_blobs blob ON blob.id=version.blob_id AND blob.sha256=frozen.sha256
      JOIN public.ged_upload_sessions scan ON scan.id=version.upload_session_id
       AND scan.scan_status='clean' AND scan.quarantine_status='released'
     WHERE version.status IN('APPLICABLE','OBSOLETE')
       AND blob.mime_type IN('application/pdf','image/png','image/jpeg')
       AND blob.size_bytes>0 AND blob.size_bytes<=52428800
       AND EXISTS(SELECT 1 FROM public.ged_document_links link
          WHERE link.document_id=document.id AND link.entity_type='PIECE_TECHNIQUE_VERSION'
            AND link.entity_id=$1 AND link.link_role=frozen.link_role)
     ORDER BY frozen.position`, [technicalVersionId, JSON.stringify(rows)]);
  return result.rows;
}
