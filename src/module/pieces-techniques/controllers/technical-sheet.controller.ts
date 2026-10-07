import type { Request } from "express";
import { z } from "zod";
import { asyncHandler } from "../../../utils/asyncHandler";
import { HttpError } from "../../../utils/httpError";
import { setSecureDownloadHeaders } from "../../../shared/uploads/secure-download";
import { buildAuditContext } from "../../project-office/controllers/project-office.controller";
import * as service from "../services/technical-sheet.service";
import { canWritePieceTechnique } from "../pieces-techniques.permissions";

const paramsSchema = z.object({
  id: z.string().uuid(),
  versionId: z.string().uuid(),
});
const issueSchema = z
  .object({
    source_revision: z.string().regex(/^[a-f0-9]{64}$/),
    reissue_reason: z.string().trim().min(1).max(1000).nullable().optional(),
  })
  .strict();
async function scope(req: Request) {
  const p = paramsSchema.parse(req.params);
  await service.assertTechnicalSheetReadable(p.id, p.versionId);
  return p;
}
export const technicalSheetSource = asyncHandler(async (req, res) => {
  const p = await scope(req);
  res.setHeader("Cache-Control", "private, no-store");
  res.json(await service.getTechnicalSheetSource(p.id, p.versionId));
});
export const listTechnicalSheets = asyncHandler(async (req, res) => {
  const p = await scope(req);
  res.setHeader("Cache-Control", "private, no-store");
  res.json(await service.listTechnicalSheets(p.id, p.versionId));
});
export const issueTechnicalSheet = asyncHandler(async (req, res) => {
  if (!canWritePieceTechnique(req.user))
    throw new HttpError(
      403,
      "TECHNICAL_SHEET_ISSUE_FORBIDDEN",
      "Le droit de rédaction du dossier technique est requis pour archiver une nouvelle édition.",
    );
  const p = await scope(req),
    key = req.get("Idempotency-Key")?.trim() ?? "";
  if (!z.string().uuid().safeParse(key).success)
    throw new HttpError(
      400,
      "IDEMPOTENCY_KEY_REQUIRED",
      "Une clé d’idempotence UUID est requise.",
    );
  res.setHeader("Cache-Control", "private, no-store");
  res
    .status(201)
    .json(
      await service.queueTechnicalSheet(
        p.id,
        p.versionId,
        key,
        buildAuditContext(req),
        issueSchema.parse(req.body),
      ),
    );
});
const send = (download: boolean) =>
  asyncHandler(async (req, res) => {
    const p = await scope(req),
      documentId = z.string().uuid().parse(req.params.documentId);
    const file = await service.readTechnicalSheet(
      p.id,
      p.versionId,
      documentId,
      buildAuditContext(req).user_id!,
      download ? "AUTHORITATIVE_PDF_DOWNLOADED" : "AUTHORITATIVE_PDF_PREVIEWED",
    );
    setSecureDownloadHeaders(res, {
      filename: file.filename,
      mimeType: "application/pdf",
      download,
    });
    res.setHeader("Content-Length", String(file.bytes.byteLength));
    res.send(file.bytes);
  });
export const previewTechnicalSheet = send(false);
export const downloadTechnicalSheet = send(true);
export const printTechnicalSheet = asyncHandler(async (req, res) => {
  const p = await scope(req),
    documentId = z.string().uuid().parse(req.params.documentId);
  await service.printTechnicalSheet(
    p.id,
    p.versionId,
    documentId,
    buildAuditContext(req).user_id!,
  );
  res.status(204).send();
});
