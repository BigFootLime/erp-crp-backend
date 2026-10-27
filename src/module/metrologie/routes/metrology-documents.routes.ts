import { Router, type Request } from "express";
import { z } from "zod";
import { asyncHandler } from "../../../utils/asyncHandler";
import { HttpError } from "../../../utils/httpError";
import { getClientIp, parseDevice } from "../../../utils/requestMeta";
import { resolveMetrologyDocumentStoragePath } from "../../../utils/cerpStorage";
import { createSecureUpload } from "../../../shared/uploads/secure-upload";
import { sendSecureStoredFile } from "../../../shared/uploads/secure-download";
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository";
import * as ged from "../../ged/services/ged.service";
import { svcMetrologyDocsBaseDir } from "../services/metrology-360.service";
import { requireMetrologyCapability } from "../middlewares/metrology-authorization.middleware";
import {
  assertEquipmentDocumentParent, getEquipmentDocumentContent, listEquipmentDocuments,
  scanMetadataSchema, uploadEquipmentDocument,
} from "../services/metrology-documents.service";

const router = Router();
const uuid = z.string().guid();
const upload = createSecureUpload("quality-document", { storage: "staging", scan: "deferred", maxFiles: 1 });

function actorFrom(req: Request): ged.GedActor {
  if (!req.user || typeof req.user.id !== "number") throw new HttpError(401, "UNAUTHORIZED", "Authentification requise.");
  return { id: req.user.id, role: typeof req.user.role === "string" ? req.user.role : null };
}
function id(value: unknown): string {
  const parsed = uuid.safeParse(value);
  if (!parsed.success) throw new HttpError(422, "METROLOGY_VALIDATION_ERROR", "Identifiant invalide.");
  return parsed.data;
}

router.get("/equipements/:id/documents", requireMetrologyCapability("documents_read"), asyncHandler(async (req, res) => {
  const query = z.object({
    page: z.coerce.number().int().min(1).max(10000).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(200),
  }).strict().safeParse(req.query);
  if (!query.success) throw new HttpError(422, "METROLOGY_VALIDATION_ERROR", "Pagination invalide.");
  res.json(await listEquipmentDocuments(actorFrom(req), id(req.params.id), query.data.page, query.data.pageSize));
}));

router.post("/equipements/:id/documents", requireMetrologyCapability("documents_write"),
  asyncHandler(async (req, _res, next) => {
    await assertEquipmentDocumentParent(actorFrom(req), id(req.params.id));
    next();
  }), upload.single("file"), asyncHandler(async (req, res) => {
    const metadata = scanMetadataSchema.safeParse(req.body);
    if (!metadata.success) throw new HttpError(422, "METROLOGY_VALIDATION_ERROR", "Champs du document invalides.", metadata.error.flatten());
    res.status(201).json(await uploadEquipmentDocument(actorFrom(req), id(req.params.id), metadata.data, req.file));
  }));

router.get("/equipements/:id/documents/:docId/file", requireMetrologyCapability("documents_read"), asyncHandler(async (req, res) => {
  const actor = actorFrom(req);
  const equipmentId = id(req.params.id);
  const content = await getEquipmentDocumentContent(actor, equipmentId, id(req.params.docId));
  res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'");
  if (content.kind === "source") {
    const userAgent = typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null;
    const device = parseDevice(userAgent);
    await repoInsertAuditLog({
      user_id: actor.id,
      ip: getClientIp(req), user_agent: userAgent,
      device_type: device.device_type, os: device.os, browser: device.browser,
      body: {
        event_type: "ACTION", action: "METROLOGY_SOURCE_DOCUMENT_READ",
        entity_type: "metrologie_equipements", entity_id: equipmentId,
        details: { source_file_id: content.source.id, sha256: content.source.sha256, delivery: "authorized" },
      },
    });
    res.setHeader("X-CERP-Document-SHA256", content.source.sha256);
    await sendSecureStoredFile(res, {
      filePath: resolveMetrologyDocumentStoragePath(content.source.storage_path, svcMetrologyDocsBaseDir()),
      allowedRoots: [svcMetrologyDocsBaseDir()],
      filename: content.source.source_name, mimeType: content.source.mime_type ?? "application/octet-stream",
      download: true, expectedSha256: content.source.sha256,
    });
    return;
  }
  const result = content.content;
  await ged.recordVersionDownloadAuthorized(actor, result);
  res.setHeader("X-CERP-Document-SHA256", result.sha256);
  try {
    const outcome = await sendSecureStoredFile(res, {
      filePath: result.file_path, allowedRoots: [result.allowed_root],
      filename: result.original_name, mimeType: result.mime_type, download: true,
      expectedSha256: result.sha256,
      integrityError: { status: 409, code: "GED_INTEGRITY", message: "L'intégrité du document ne peut pas être vérifiée." },
    });
    if (outcome === "completed") await ged.recordVersionDownload(actor, result, "DOWNLOAD");
  } catch (error) {
    if (error instanceof HttpError && error.code === "GED_INTEGRITY") await ged.recordVersionDownload(actor, result, "INTEGRITY_FAILURE");
    throw error;
  }
}));

export default router;
