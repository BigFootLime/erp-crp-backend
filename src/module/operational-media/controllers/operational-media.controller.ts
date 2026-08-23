import type { RequestHandler } from "express";
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository";
import { getClientIp, parseDevice } from "../../../utils/requestMeta";
import { sendSecureStoredFile } from "../../../shared/uploads/secure-download";
import { mediaFilename } from "../repository/operational-media.repository";
import { collectOperationalMediaCapabilities } from "../services/operational-media-health.service";
import { authorizeOperationalMediaRead } from "../services/operational-media.service";
import logger from "../../../utils/logger";

export const getMediaCapabilities: RequestHandler = async (_req, res, next) => {
  try {
    res.json(await collectOperationalMediaCapabilities());
  } catch (error) {
    next(error);
  }
};

export const downloadOperationalImage: RequestHandler = async (req, res, next) => {
  try {
    const userId = req.user?.id;
    if (typeof userId !== "number") { res.status(401).json({ error: "Utilisateur non authentifié" }); return; }
    const assetId = typeof req.params.assetId === "string" ? req.params.assetId : "";
    const media = await authorizeOperationalMediaRead({ assetId, userId });
    const userAgent = typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null;
    const device = parseDevice(userAgent);
    const auditContext = {
      user_id: userId,
      ip: getClientIp(req),
      user_agent: userAgent,
      device_type: device.device_type,
      os: device.os,
      browser: device.browser,
    };
    const auditBody = (action: "OPERATIONAL_MEDIA_READ_AUTHORIZED" | "OPERATIONAL_MEDIA_READ_COMPLETED") => ({
      event_type: "ACTION" as const,
      action,
      page_key: typeof req.headers["x-page-key"] === "string" ? req.headers["x-page-key"] : null,
      entity_type: media.asset.owner_type,
      entity_id: media.asset.owner_id,
      path: "/api/v1/operational-media/:assetId/content",
      client_session_id: typeof req.headers["x-client-session-id"] === "string" ? req.headers["x-client-session-id"] : null,
      details: {
        asset_id: media.asset.id,
        module_key: media.asset.module_key,
        disposition: req.query.download === "1" ? "attachment" : "inline",
      },
    });
    // This durable authorization receipt is deliberately before any bytes are
    // sent: if audit storage is unavailable, private media remains unavailable.
    await repoInsertAuditLog({ ...auditContext, body: auditBody("OPERATIONAL_MEDIA_READ_AUTHORIZED") });
    // Operational media is capped at 25 MiB. Send the exact bytes that were
    // hash-verified, rather than streaming a mutable inode after verification.
    const outcome = await sendSecureStoredFile(res, {
      filePath: media.filePath,
      allowedRoots: media.allowedRoots,
      filename: mediaFilename(media.asset),
      mimeType: media.mimeType,
      expectedSha256: media.expectedSha256,
      snapshotVerifiedBytes: true,
      maxSnapshotBytes: 25 * 1024 * 1024,
      integrityError: {
        status: 503,
        code: "MEDIA_INTEGRITY_ERROR",
        message: "L’intégrité du média ne peut pas être confirmée.",
      },
      download: req.query.download === "1",
    });
    // An aborted stream is not a completion. Completion is best-effort after
    // `finish`: at this point an audit failure cannot honestly be returned to
    // the client, so record an operational error rather than claiming success.
    if (outcome === "completed") {
      try {
        await repoInsertAuditLog({ ...auditContext, body: auditBody("OPERATIONAL_MEDIA_READ_COMPLETED") });
      } catch {
        logger.error("operational_media_completion_audit_failed", { asset_id: media.asset.id, user_id: userId });
      }
    }
  } catch (error) { next(error); }
};
