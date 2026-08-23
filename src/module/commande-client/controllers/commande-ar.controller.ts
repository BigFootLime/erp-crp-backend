import type { Request, RequestHandler } from "express";

import { HttpError } from "../../../utils/httpError";
import { asyncHandler } from "../../../utils/asyncHandler";
import { acknowledgementDocumentParamsSchema, createAcknowledgementSchema, generateCommandeArSchema, sendAcknowledgementSchema, sendCommandeArSchema } from "../validators/commande-ar.validators";
import { svcCreateCommandeArOfficial, svcGenerateCommandeAr, svcGetCommandeArOfficialDocument, svcListCommandeArOfficialDocuments, svcReadCommandeArOfficialDocument, svcRecordCommandeArOfficialPrint, svcSendCommandeAr, svcSendCommandeArOfficial } from "../services/commande-ar.service";

function getUserId(req: Request): number {
  const userId = typeof req.user?.id === "number" ? req.user.id : null;
  if (!userId) throw new HttpError(401, "UNAUTHORIZED", "Authentication required");
  return userId;
}

export const generateCommandeAr: RequestHandler = asyncHandler(async (req, res) => {
  const { id } = generateCommandeArSchema.parse({ params: req.params }).params;
  const out = await svcGenerateCommandeAr({
    commande_id: Number(id),
    user_id: getUserId(req),
    user_role: req.user?.role,
  });
  res.status(201).json(out);
});

export const sendCommandeAr: RequestHandler = asyncHandler(async (req, res) => {
  const parsed = sendCommandeArSchema.parse({ params: req.params, body: req.body });
  const out = await svcSendCommandeAr({
    commande_id: Number(parsed.params.id),
    user_id: getUserId(req),
    user_role: req.user?.role,
    body: parsed.body,
  });
  res.status(200).json(out);
});

/** Collection POST uses the same checkpoint authorization as the legacy AR generator. */
export const createAcknowledgement: RequestHandler = asyncHandler(async (req, res) => {
  const parsed = createAcknowledgementSchema.parse({ params: req.params, body: req.body });
  const key = req.headers["idempotency-key"];
  if (typeof key !== "string" || key.trim().length < 8 || key.trim().length > 120) {
    throw new HttpError(400, "IDEMPOTENCY_KEY_REQUIRED", "Une clé d'idempotence est requise.");
  }
  const out = await svcCreateCommandeArOfficial({ commande_id: Number(parsed.params.id), user_id: getUserId(req), user_role: req.user?.role, source_revision: parsed.body.source_revision, reissue_reason: parsed.body.reissue_reason, idempotency_key: key.trim() });
  res.status(201).json(out);
});

export const listAcknowledgements: RequestHandler = asyncHandler(async (req, res) => {
  const { id } = generateCommandeArSchema.parse({ params: req.params }).params;
  res.json(await svcListCommandeArOfficialDocuments(Number(id)));
});

export const getAcknowledgement: RequestHandler = asyncHandler(async (req, res) => {
  const { id, documentId } = acknowledgementDocumentParamsSchema.parse(req.params);
  const out = await svcGetCommandeArOfficialDocument(Number(id), documentId);
  if (!out) throw new HttpError(404, "OFFICIAL_DOCUMENT_NOT_FOUND", "Document officiel introuvable.");
  res.json(out);
});

function sendAcknowledgementPdf(disposition: "inline" | "attachment"): RequestHandler {
  return asyncHandler(async (req, res) => {
    const { id, documentId } = acknowledgementDocumentParamsSchema.parse(req.params);
    const file = await svcReadCommandeArOfficialDocument(Number(id), documentId, getUserId(req), disposition === "inline" ? "AUTHORITATIVE_PDF_PREVIEWED" : "AUTHORITATIVE_PDF_DOWNLOADED");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Length", String(file.bytes.byteLength));
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Content-Disposition", `${disposition}; filename="${file.filename}"`);
    res.send(file.bytes);
  });
}
export const previewAcknowledgement = sendAcknowledgementPdf("inline");
export const downloadAcknowledgement = sendAcknowledgementPdf("attachment");
export const printAcknowledgement: RequestHandler = asyncHandler(async (req, res) => {
  const { id, documentId } = acknowledgementDocumentParamsSchema.parse(req.params);
  await svcRecordCommandeArOfficialPrint(Number(id), documentId, getUserId(req));
  res.status(204).send();
});
export const sendAcknowledgement: RequestHandler = asyncHandler(async (req, res) => {
  const parsed = sendAcknowledgementSchema.parse({ params: req.params, body: req.body });
  const out = await svcSendCommandeArOfficial({ commande_id: Number(parsed.params.id), archive_id: parsed.params.documentId, user_id: getUserId(req), user_role: req.user?.role, body: parsed.body });
  res.status(200).json(out);
});
