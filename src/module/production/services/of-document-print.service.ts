import { createHash } from "node:crypto";
import { HttpError } from "../../../utils/httpError";
import { insertAuditLog, type AuditContext } from "../../project-office/repository/project-office.repository";
import type { OfDocumentPayload } from "../domain/of-document";
import { nextWorkshopOfficialOrdinal, workshopCopyMark, type WorkshopCopyStatus } from "../domain/workshop-print-policy";
import * as prints from "../repository/of-document-print.repository";
import * as documents from "../repository/of-versioning.repository";
import { archiveOfDocument, compensateOfDocumentArchive, readArchivedOfDocument, type OfDocumentArchiveResult } from "./of-document-archive";
import { readOfDocumentStoredPdf } from "./of-document-stored-pdf";
import { composeWorkshopPackPdf } from "./workshop-pack-pdf";

const digest = (pdf: Buffer) => createHash("sha256").update(pdf).digest("hex");
export type OfPrintDelivery = {
  expectedDocumentStatus: string;
  deliver: (tx: documents.DbQueryer, intent: prints.OfPrintIntent) => Promise<Buffer>;
  replay: (intent: prints.OfPrintIntent) => Promise<Buffer>;
};
function assertScope(intent: prints.OfPrintIntent, ofId: number, documentId: string, actorId: number) {
  if (intent.of_id !== ofId || intent.document_id !== documentId || intent.actor_id !== actorId) {
    throw new HttpError(409,"IDEMPOTENCY_KEY_REUSED","Cette demande concerne une autre impression.");
  }
}
async function readExactCopy(intent: prints.OfPrintIntent, document: documents.OfDocumentRow): Promise<Buffer> {
  if (document.statut !== intent.document_status) throw new HttpError(409,"OF_PRINT_VERSION_CHANGED","La version du document a changé. Actualisez avant de l’imprimer.");
  const pdf = intent.copy_sha256 === document.pdf_sha256
    ? (await readOfDocumentStoredPdf(document)).pdf : await readArchivedOfDocument(intent.copy_sha256);
  if (!pdf || digest(pdf) !== intent.copy_sha256 || pdf.length !== intent.copy_byte_size) {
    throw new HttpError(503,"OF_PRINT_COPY_UNAVAILABLE","L’exemplaire enregistré est indisponible. Réessayez cette même demande.");
  }
  return pdf;
}

/** Download is a read. Only this explicit command accepts an official ordinal.
 * The same key keeps its exact archived copy, even after a lost COMMIT reply. */
export async function requestOfDocumentPrint(ofId: number, documentId: string, key: string, actorId: number, audit: AuditContext, delivery?: OfPrintDelivery) {
  let ownership: OfDocumentArchiveResult | null = null;
  try {
    return await documents.withOfTransaction(async tx => {
      await prints.lockPrintKey(tx,key);
      await documents.lockOf(tx,ofId);
      const document = await documents.getDocument(ofId,documentId,tx);
      if (!document) throw new HttpError(404,"OF_DOCUMENT_NOT_FOUND","Document introuvable sur cet ordre de fabrication.");
      if (delivery && document.statut !== delivery.expectedDocumentStatus) {
        throw new HttpError(409,"OF_PRINT_VERSION_CHANGED","La version du dossier a changé. Actualisez avant d’imprimer.");
      }
      const existing = await prints.findPrintIntent(key,tx);
      if (existing) {
        assertScope(existing,ofId,documentId,actorId);
        const copy=await readExactCopy(existing,document);
        return { intent:existing, pdf:delivery ? await delivery.deliver(tx,existing) : copy, replayed:true };
      }
      const ordinal = document.statut === "OFFICIEL"
        ? nextWorkshopOfficialOrdinal(await prints.officialPrintCount(tx,ofId,document.revision_id)) : null;
      const mark = workshopCopyMark(document.statut as WorkshopCopyStatus,ordinal);
      const original = await readOfDocumentStoredPdf(document);
      let pdf = original.pdf;
      // A saved draft already carries BROUILLON; retain its exact archived bytes.
      const needsOverlay = Boolean(mark && (document.payload as OfDocumentPayload).watermark !== mark);
      if (needsOverlay) {
        const variant = await prints.readPrintVariant(tx,documentId,mark!);
        if (variant) {
          const saved = await readArchivedOfDocument(variant.pdf_sha256);
          if (!saved || digest(saved) !== variant.pdf_sha256 || saved.length !== variant.pdf_byte_size) {
            throw new HttpError(503,"OF_PRINT_COPY_UNAVAILABLE","L’exemplaire enregistré est indisponible. Réessayez.");
          }
          pdf = saved;
        } else {
          const payload = document.payload as OfDocumentPayload;
          const rendered = await composeWorkshopPackPdf({number:payload.ofNumero,generatedAt:document.generated_at,ofMark:mark,
            parts:[{kind:"OF",name:payload.ofNumero,bytes:original.pdf,sha256:document.pdf_sha256!}]});
          const archive = await archiveOfDocument(tx,{ofNumero:`${payload.ofNumero} ${mark}`,revisionCode:payload.revisionCode,
            pieceReference:payload.pieceReference,pdf:rendered.bytes,pdfSha256:rendered.sha256,existingGedDocumentId:null,
            actorUserId:actorId,changeReason:`Exemplaire ${mark}`}, owned=>{ownership=owned;});
          ownership = archive;
          if (!archive.archived || !archive.gedDocumentId || !archive.gedVersionId) {
            throw new HttpError(503,"OF_PRINT_ARCHIVE_REQUIRED","Le coffre documentaire doit être disponible avant impression.");
          }
          await prints.insertPrintVariant(tx,documentId,mark!,{pdf_sha256:rendered.sha256,pdf_byte_size:rendered.bytes.length,
            ged_document_id:archive.gedDocumentId,ged_version_id:archive.gedVersionId});
          pdf = rendered.bytes;
        }
      }
      const intent = await prints.insertPrintIntent(tx,key,{of_id:ofId,document_id:documentId,revision_id:document.revision_id,
        actor_id:actorId,document_status:document.statut,official_ordinal:ordinal,copy_mark:mark,
        copy_sha256:digest(pdf),copy_byte_size:pdf.length});
      await insertAuditLog(tx,audit,{action:"OF_DOCUMENT_PRINT_INTENT",entity_type:"of_document",entity_id:documentId,
        details:{of_id:ofId,print_intent_id:intent.id,official_ordinal:ordinal,copy_mark:mark,pdf_sha256:intent.copy_sha256,
          physical_print_confirmed:false}});
      return { intent,pdf:delivery ? await delivery.deliver(tx,intent) : pdf,replayed:false };
    },{afterConfirmedRollback:()=>compensateOfDocumentArchive(ownership)});
  } catch (error) {
    if (!(error instanceof documents.OfCommitUncertainError)) throw error;
    const saved = await prints.findPrintIntent(key);
    if (!saved) throw error; // Same key is required on retry; no inferred success.
    assertScope(saved,ofId,documentId,actorId);
    const document = await documents.getDocument(ofId,documentId);
    if (!document) throw error;
    const originalCopy = await readExactCopy(saved,document);
    return {intent:saved,pdf:delivery ? await delivery.replay(saved) : originalCopy,replayed:true};
  }
}
