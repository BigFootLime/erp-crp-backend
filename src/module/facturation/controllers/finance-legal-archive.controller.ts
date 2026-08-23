import type { RequestHandler } from "express";
import { HttpError } from "../../../utils/httpError";
import { financeLegacyIdParamsSchema } from "../validators/workflow.validators";
import { getFinanceLegalArchive, listFinanceLegalArchive, printFinanceLegalArchive, readFinanceLegalArchive } from "../services/finance-legal-archive.service";

type Kind = "FACTURE" | "AVOIR";
const actor = (req: { user?: { id?: unknown } }) => {
  if (typeof req.user?.id !== "number" || !Number.isInteger(req.user.id) || req.user.id <= 0) throw new HttpError(401, "UNAUTHORIZED", "Authentification requise.");
  return req.user.id;
};
const send = (res: Parameters<RequestHandler>[1], bytes: Buffer, filename: string, disposition: "inline" | "attachment") => {
  res.setHeader("Content-Type", "application/pdf"); res.setHeader("Content-Length", String(bytes.byteLength));
  res.setHeader("Content-Disposition", `${disposition}; filename=\"${filename.replace(/[\\\"\r\n]/g, "_")}\"`); res.send(bytes);
};
const handlers = (kind: Kind) => ({
  list: (async (req, res, next) => { try { const { id } = financeLegacyIdParamsSchema.parse(req.params); actor(req); res.json(await listFinanceLegalArchive(kind, id)); } catch (e) { next(e); } }) as RequestHandler,
  get: (async (req, res, next) => { try { const { id } = financeLegacyIdParamsSchema.parse(req.params); const archiveId = String(req.params.documentId ?? ""); actor(req); const out = await getFinanceLegalArchive(kind, id, archiveId); if (!out) throw new HttpError(404, "OFFICIAL_DOCUMENT_NOT_FOUND", "Document officiel introuvable."); res.json(out); } catch (e) { next(e); } }) as RequestHandler,
  preview: (async (req, res, next) => { try { const { id } = financeLegacyIdParamsSchema.parse(req.params); const out = await readFinanceLegalArchive(kind, id, String(req.params.documentId ?? ""), actor(req), "AUTHORITATIVE_PDF_PREVIEWED"); send(res, out.bytes, out.filename, "inline"); } catch (e) { next(e); } }) as RequestHandler,
  download: (async (req, res, next) => { try { const { id } = financeLegacyIdParamsSchema.parse(req.params); const out = await readFinanceLegalArchive(kind, id, String(req.params.documentId ?? ""), actor(req), "AUTHORITATIVE_PDF_DOWNLOADED"); send(res, out.bytes, out.filename, "attachment"); } catch (e) { next(e); } }) as RequestHandler,
  print: (async (req, res, next) => { try { const { id } = financeLegacyIdParamsSchema.parse(req.params); await printFinanceLegalArchive(kind, id, String(req.params.documentId ?? ""), actor(req)); res.status(204).send(); } catch (e) { next(e); } }) as RequestHandler,
});
export const factureLegalArchive = handlers("FACTURE");
export const avoirLegalArchive = handlers("AVOIR");
