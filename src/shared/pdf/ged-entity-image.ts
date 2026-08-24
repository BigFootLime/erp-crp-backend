import db from "../../config/database";
import { readBlob } from "../../module/ged/services/ged-vault.service";

const MAX_PDF_ENTITY_IMAGE_BYTES = 5 * 1024 * 1024;

type EntityImageRef = {
  storage_key: string;
  sha256: string;
  mime_type: string;
  size_bytes: string | number;
};

function isSupportedRaster(buffer: Buffer, mimeType: string): boolean {
  if (mimeType === "image/png") {
    return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  }
  if (mimeType === "image/jpeg") {
    return buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer.at(-2) === 0xff && buffer.at(-1) === 0xd9;
  }
  return false;
}

/**
 * Reads one exact, immutable GED image revision for a PDF.
 *
 * The query proves all four links before any byte leaves the vault: the exact revision
 * belongs to an IMAGE_ENTITE document, is attached to the expected business
 * parent and received a clean antivirus verdict. Storage keys stay server-only.
 */
export async function readGedEntityImageVersion(input: {
  versionId: string;
  entityType: string;
  entityId: string;
}): Promise<Buffer | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.versionId)) return null;
  if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(input.entityType) || !input.entityId.trim()) return null;

  const result = await db.query<EntityImageRef>(
    `SELECT b.storage_key, b.sha256, b.mime_type, b.size_bytes::bigint::text AS size_bytes
       FROM public.ged_document_versions v
       JOIN public.ged_documents d ON d.id = v.document_id
       JOIN public.ged_blobs b ON b.id = v.blob_id
       JOIN public.ged_document_links l ON l.document_id = d.id
       JOIN public.ged_upload_sessions s ON s.id = v.upload_session_id
      WHERE v.id = $1::uuid
        AND d.class_key = 'IMAGE_ENTITE'
        AND l.entity_type = $2
        AND l.entity_id = $3
        AND s.scan_status = 'clean'
        AND b.mime_type IN ('image/png', 'image/jpeg')
      ORDER BY l.created_at DESC
      LIMIT 1`,
    [input.versionId, input.entityType, input.entityId]
  );
  const ref = result.rows[0];
  if (!ref || Number(ref.size_bytes) > MAX_PDF_ENTITY_IMAGE_BYTES) return null;

  try {
    const buffer = await readBlob(ref.storage_key, ref.sha256);
    return buffer.byteLength <= MAX_PDF_ENTITY_IMAGE_BYTES && isSupportedRaster(buffer, ref.mime_type) ? buffer : null;
  } catch {
    // An unavailable visual identity must not make the complete business PDF unavailable.
    return null;
  }
}
