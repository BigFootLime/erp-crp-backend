import type { Request } from "express";
import { z } from "zod";
import { asyncHandler } from "../../../utils/asyncHandler";
import { HttpError } from "../../../utils/httpError";
import { setSecureDownloadHeaders } from "../../../shared/uploads/secure-download";
import { buildAuditContext } from "../../project-office/controllers/project-office.controller";
import * as service from "../services/of-traveler.service";

const issueSchema = z
  .object({
    source_revision: z.string().regex(/^[a-f0-9]{64}$/),
    reissue_reason: z.string().trim().min(1).max(1000).nullable().optional(),
  })
  .strict();
async function scope(req: Request) {
  const id = z.coerce.number().int().positive().safe().parse(req.params.ofId);
  await service.assertOfTravelerReadable(id);
  return id;
}
export const ofTravelerSource = asyncHandler(async (req, res) => {
  const id = await scope(req);
  res.setHeader("Cache-Control", "private, no-store");
  res.json(await service.getOfTravelerSource(id));
});
export const listOfTravelers = asyncHandler(async (req, res) => {
  const id = await scope(req);
  res.setHeader("Cache-Control", "private, no-store");
  res.json(await service.listOfTravelers(id));
});
export const issueOfTraveler = asyncHandler(async (req, res) => {
  const id = await scope(req),
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
      await service.queueOfTraveler(
        id,
        key,
        buildAuditContext(req),
        issueSchema.parse(req.body),
      ),
    );
});
const send = (download: boolean) =>
  asyncHandler(async (req, res) => {
    const id = await scope(req),
      documentId = z.string().uuid().parse(req.params.documentId);
    const file = await service.readOfTraveler(
      id,
      documentId,
      buildAuditContext(req).user_id,
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
export const previewOfTraveler = send(false);
export const downloadOfTraveler = send(true);
export const printOfTraveler = asyncHandler(async (req, res) => {
  const id = await scope(req),
    documentId = z.string().uuid().parse(req.params.documentId);
  await service.printOfTraveler(id, documentId, buildAuditContext(req).user_id);
  res.status(204).send();
});
