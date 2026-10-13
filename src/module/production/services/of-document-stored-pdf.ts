import { createHash } from "node:crypto";
import { HttpError } from "../../../utils/httpError";
import type { OfDocumentPayload } from "../domain/of-document";
import type { OfDocumentRow } from "../repository/of-versioning.repository";
import { readArchivedOfDocument } from "./of-document-archive";
import { renderOfDocument } from "./of-document-render";

/** A replay reads its saved edition, never a freshly generated document or a newer template. */
export async function readOfDocumentStoredPdf(document: OfDocumentRow) {
  if (!document.pdf_sha256) throw new HttpError(409, "OF_DOCUMENT_NO_PDF", "Ce document n'a pas d'empreinte PDF enregistrée.");
  let pdf = await readArchivedOfDocument(document.pdf_sha256);
  const source: "GED" | "PAYLOAD" = pdf ? "GED" : "PAYLOAD";
  if (!pdf) pdf = (await renderOfDocument(document.payload as OfDocumentPayload)).buffer;
  if (createHash("sha256").update(pdf).digest("hex") !== document.pdf_sha256
    || (document.pdf_byte_size !== null && pdf.byteLength !== document.pdf_byte_size)) {
    throw new HttpError(500, "OF_DOCUMENT_REPRINT_MISMATCH", "La réimpression ne correspond pas à la version archivée.");
  }
  return { pdf, source };
}
