import pool from "../../../config/database";
import logger from "../../../utils/logger";
import { getImagesRootPath } from "../../../utils/imageStorage";
import { scanUpload } from "../../../shared/uploads/upload-scanner";
import { verifyOperationalRaster } from "./operational-media-promotion.service";

type LegacyRow = Readonly<{ id: string; storage_key: string; has_raster_only_binding: boolean }>;
export type OperationalMediaReconciliationSummary = Readonly<{
  examined: number;
  activated: number;
  quarantined_invalid: number;
  quarantined_infected: number;
  scanner_unavailable: number;
}>;

async function quarantine(id: string): Promise<void> {
  await pool.query(
    `UPDATE public.operational_media_assets
       SET status = 'QUARANTINED', scan_status = 'QUARANTINED'
     WHERE id = $1::uuid AND status = 'LEGACY_UNVERIFIED'`,
    [id],
  );
}

/**
 * Idempotently promotes only legacy files whose real bytes, containment and
 * current antivirus verdict all pass. No filename or storage key is logged.
 */
export async function reconcileLegacyOperationalMedia(params: { batchSize?: number } = {}): Promise<OperationalMediaReconciliationSummary> {
  const batchSize = Number.isSafeInteger(params.batchSize) && params.batchSize! > 0 && params.batchSize! <= 500
    ? params.batchSize!
    : 100;
  const summary = { examined: 0, activated: 0, quarantined_invalid: 0, quarantined_infected: 0, scanner_unavailable: 0 };

  for (;;) {
    const batch = await pool.query<LegacyRow>(
      `SELECT a.id::text AS id, a.storage_key,
              EXISTS (
                SELECT 1 FROM public.operational_media_bindings b
                 WHERE b.asset_id = a.id
                   AND NOT (b.owner_type = 'outil' AND b.field_key IN ('plan', 'esquisse'))
              ) AS has_raster_only_binding
         FROM public.operational_media_assets a
        WHERE a.status = 'LEGACY_UNVERIFIED'
        ORDER BY created_at ASC, id ASC
        LIMIT $1`,
      [batchSize],
    );
    if (!batch.rows.length) break;

    for (const asset of batch.rows) {
      summary.examined += 1;
      const verified = await verifyOperationalRaster({ root: getImagesRootPath(), storageKey: asset.storage_key, includeBytes: true });
      if (!verified) {
        await quarantine(asset.id);
        summary.quarantined_invalid += 1;
        logger.warn("operational_media_legacy_quarantined", { asset_id: asset.id, reason: "durable_raster_invalid" });
        continue;
      }

      if (!verified.bytes) {
        await quarantine(asset.id);
        summary.quarantined_invalid += 1;
        logger.warn("operational_media_legacy_quarantined", { asset_id: asset.id, reason: "durable_bytes_missing" });
        continue;
      }

      // PDFs are document-only: only tool plan/esquisse bindings may become
      // active. Quarantine before scanning/publishing any legacy PDF with a
      // raster-only binding; the database trigger enforces the same rule.
      if (asset.has_raster_only_binding && verified.mimeType === "application/pdf") {
        await quarantine(asset.id);
        summary.quarantined_invalid += 1;
        logger.warn("operational_media_legacy_quarantined", { asset_id: asset.id, reason: "pdf_raster_binding" });
        continue;
      }

      // Scan the exact bytes read and hashed from the verified inode. Scanning
      // the pathname would permit a local writer to swap the file between the
      // integrity pass and the antivirus verdict.
      const scan = await scanUpload({ buffer: verified.bytes });
      if (scan.status === "infected") {
        await quarantine(asset.id);
        summary.quarantined_infected += 1;
        logger.warn("operational_media_legacy_quarantined", { asset_id: asset.id, reason: "scanner_infected", provider: scan.provider });
        continue;
      }
      if (scan.status !== "clean") {
        // Preserve LEGACY_UNVERIFIED for a safe retry; no scanner outage can
        // silently publish historic bytes.
        summary.scanner_unavailable += 1;
        logger.warn("operational_media_legacy_not_activated", { asset_id: asset.id, reason: "scanner_unavailable", provider: scan.provider });
        continue;
      }

      const updated = await pool.query(
        `UPDATE public.operational_media_assets
            SET mime_type = $2, size_bytes = $3, sha256 = $4,
                scan_status = 'CLEAN', status = 'ACTIVE'
          WHERE id = $1::uuid AND status = 'LEGACY_UNVERIFIED'`,
        [asset.id, verified.mimeType, verified.size, verified.sha256],
      );
      if ((updated.rowCount ?? 0) === 1) {
        summary.activated += 1;
        logger.info("operational_media_legacy_activated", { asset_id: asset.id, mime_type: verified.mimeType, size_bytes: verified.size });
      }
    }
    // Unavailable verdicts intentionally remain eligible for a later run. Do
    // not spin forever on the same first page while the scanner is degraded.
    if (summary.scanner_unavailable > 0) return summary;
  }
  return summary;
}
