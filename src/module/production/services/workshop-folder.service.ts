import { createHash } from "node:crypto";
import { HttpError } from "../../../utils/httpError";
import { readBlob } from "../../ged/services/ged-vault.service";
import { insertAuditLog, type AuditContext } from "../../project-office/repository/project-office.repository";
import type { OfDocumentPayload } from "../domain/of-document";
import type { OfPrintIntent } from "../repository/of-document-print.repository";
import * as documents from "../repository/of-versioning.repository";
import * as folders from "../repository/workshop-folder.repository";
import { readWorkshopAnnexSources } from "../repository/workshop-annex.repository";
import { readOfDossierTx } from "../repository/of-dossier.repository";
import { archiveOfDocument, compensateOfDocumentArchive, readArchivedOfDocument, type OfDocumentArchiveResult } from "./of-document-archive";
import { buildDocumentPayload, emitDocument, type OfActor } from "./of-versioning.service";
import { readOfDocumentStoredPdf } from "./of-document-stored-pdf";
import { requestOfDocumentPrint } from "./of-document-print.service";
import { composeWorkshopPackPdf, type WorkshopPdfPart } from "./workshop-pack-pdf";
import { renderWorkshopSupportPaper, type WorkshopSupportKind } from "./workshop-support-paper";
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const scopedKey = (scope: string, key: string) => `folder:${digest(Buffer.from(scope + "\0" + key))}`;
const copyUnavailable = () => new HttpError(503, "WORKSHOP_FOLDER_COPY_UNAVAILABLE", "Le dossier archivé est indisponible. Réessayez la même demande.");
async function assertPreparation(tx: documents.DbQueryer, ofId: number, expectedStatus?: "OFFICIEL" | "BROUILLON") {
    const dossier = await readOfDossierTx(tx, ofId);
    if (["ANNULE", "ARCHIVE"].includes(dossier.executionStatus))
        throw new HttpError(409, "WORKSHOP_OF_CLOSED", "Cet OF est annulé ou archivé.");
    if (dossier.status !== "COMPLETE")
        throw new HttpError(422, "WORKSHOP_PREPARATION_REQUIRED", "Validez la préparation de l’OF avant de préparer son dossier.", { actions: [{ section: "preparation", label: "Préparation de l’OF" }] });
    const status = dossier.planning.planned > 0 ? "OFFICIEL" : "BROUILLON";
    if (expectedStatus && expectedStatus !== status)
        throw new HttpError(409, "WORKSHOP_PLANNING_CHANGED", "Le planning a changé. Actualisez le dossier.");
    return status;
}
async function readCopy(copy: folders.FolderCopyRow): Promise<Buffer> {
    const pdf = await readArchivedOfDocument(copy.pdf_sha256);
    if (!pdf || digest(pdf) !== copy.pdf_sha256 || pdf.length !== copy.pdf_byte_size)
        throw copyUnavailable();
    return pdf;
}
async function metadata(folder: folders.WorkshopFolderRow) {
    const document = await documents.getDocument(folder.of_id, folder.document_id);
    if (!document)
        throw new HttpError(404, "OF_DOCUMENT_NOT_FOUND", "Document introuvable sur cet OF.");
    const mark = document.statut !== folder.document_status ? "OBSOLETE" : folder.document_status === "OFFICIEL" ? "ORIGINAL" : folder.document_status;
    const copy = await documents.withOfDocumentReadTransaction(tx => folders.getWorkshopFolderCopy(tx, folder.id, mark));
    if (!copy)
        throw copyUnavailable();
    return { id: folder.id, documentId: folder.document_id, status: document.statut, pages: copy.page_count,
        parts: copy.page_manifest.map(part => ({ kind: part.kind, label: part.name, pages: part.page_count })),
        preparationKind: folder.preparation_kind };
}
async function readAnnexes(tx: documents.DbQueryer, document: Pick<documents.OfDocumentRow, "of_id" | "revision_id" | "payload">) {
    const source = await readWorkshopAnnexSources(tx, document);
    const actions: Array<{
        section: string;
        label: string;
    }> = [];
    if (!source.hasClientPlan || source.missingPlans.some(p => p.role === "PLAN_CLIENT"))
        actions.push({ section: "plan_client", label: "Plan client" });
    if (source.missingPlans.some(p => p.role === "PLAN_FABRICATION"))
        actions.push({ section: "plan_fabrication", label: "Plan de fabrication" });
    if (!source.inspection)
        actions.push({ section: "autocontrole", label: "Fiche d’autocontrôle" });
    if (actions.length)
        throw new HttpError(422, "WORKSHOP_FOLDER_ANNEXES_REQUIRED", "Complétez les documents du dossier.", { actions });
    const parts: WorkshopPdfPart[] = [], manifest: folders.FolderSourcePart[] = [];
    for (const plan of source.plans) {
        const bytes = await readBlob(plan.storage_key, plan.sha256);
        if (bytes.length !== plan.size_bytes)
            throw copyUnavailable();
        parts.push({ kind: plan.role, name: plan.label, bytes, sha256: plan.sha256 });
        manifest.push({ kind: plan.role, name: plan.label, sha256: plan.sha256, id: plan.document_id, version_id: plan.version_id });
    }
    const sheet = source.inspection!;
    if (digest(sheet.pdf) !== sheet.pdf_sha256)
        throw copyUnavailable();
    parts.push({ kind: "AUTOCONTROLE", name: "Fiche d’autocontrôle", bytes: sheet.pdf, sha256: sheet.pdf_sha256 });
    manifest.push({ kind: "AUTOCONTROLE", name: "Fiche d’autocontrôle", sha256: sheet.pdf_sha256, id: sheet.id, source_hash: sheet.source_hash });
    return { parts, manifest };
}
async function supportParts(payload: OfDocumentPayload, preparationKind: WorkshopSupportKind | null) {
    const result: WorkshopPdfPart[] = [];
    for (const kind of ["IMPROVEMENT", ...(preparationKind ? [preparationKind] : [])] as WorkshopSupportKind[]) {
        const bytes = await renderWorkshopSupportPaper({ ...payload, watermark: null }, kind);
        result.push({ kind, name: kind === "IMPROVEMENT" ? "Informations techniques et suivi" : "Préparation de fabrication", bytes, sha256: digest(bytes) });
    }
    return result;
}
/** All annexes are resolved before emission and before allocation of a print.
 * Completeness remains separate from planning: before the first committed
 * slot the packet's OF is a draft, even if its definition is already frozen. */
export async function prepareWorkshopFolder(ofId: number, key: string, actor: OfActor, audit: AuditContext) {
    const preparationKey = scopedKey(`prepare:${ofId}:${actor.userId}`, key);
    const replay = await folders.findWorkshopFolderByKey(preparationKey);
    if (replay) {
        if (replay.of_id !== ofId || replay.preparation_actor_id !== actor.userId)
            throw new HttpError(409, "IDEMPOTENCY_KEY_REUSED", "Cette demande concerne un autre dossier.");
        return { folder: await metadata(replay), replayed: true };
    }
    const preview = await buildDocumentPayload(ofId, { documentStatut: "BROUILLON", generatedAt: new Date().toISOString(), auteur: actor.username });
    if (!preview.payload.sourceFingerprint)
        throw new HttpError(409, "OF_DOCUMENT_SOURCE_UNAVAILABLE", "Actualisez l’OF avant de préparer son dossier.");
    const status = await documents.withOfDocumentReadTransaction(tx => assertPreparation(tx, ofId));
    const already = status === "OFFICIEL" ? await documents.getOfficialDocument(ofId, preview.revisionId) : null;
    // A current source cannot silently replace an old official definition.
    const selected = { of_id: ofId, revision_id: preview.revisionId, payload: already?.payload ?? preview.payload };
    await documents.withOfDocumentReadTransaction(tx => readAnnexes(tx, selected));
    const sourceKey = scopedKey(`of:${ofId}:${status}:${preview.revisionId}`, preview.payload.sourceFingerprint);
    const emitted = already ? { document: already } : await emitDocument(ofId, { revisionId: preview.revisionId,
        expectedSnapshotSha256: preview.payload.snapshotSha256, expectedSourceFingerprint: preview.payload.sourceFingerprint }, actor, audit, sourceKey, preview.payload.generatedAt, status, async (tx) => { await assertPreparation(tx, ofId, status); });
    const document = emitted.document, payload = document.payload as OfDocumentPayload;
    const ownership: OfDocumentArchiveResult[] = [];
    try {
        const result = await documents.withOfTransaction(async (tx) => {
            await documents.lockOf(tx, ofId);
            const current = await documents.getDocument(ofId, document.id, tx);
            if (!current || current.statut !== status)
                throw new HttpError(409, "OF_PRINT_VERSION_CHANGED", "L’OF a changé. Actualisez le dossier.");
            const keyed = await folders.findWorkshopFolderByKey(preparationKey, tx);
            if (keyed)
                return keyed;
            await assertPreparation(tx, ofId, status);
            const annexes = await readAnnexes(tx, document);
            const preparationKind = await folders.workshopPreparationKind(tx, ofId, payload.pieceIndice);
            const supports = await supportParts(payload, preparationKind);
            const original = await readOfDocumentStoredPdf(document);
            const parts: WorkshopPdfPart[] = [{ kind: "OF", name: payload.ofNumero, bytes: original.pdf, sha256: document.pdf_sha256! }, ...annexes.parts, ...supports];
            const manifest: folders.FolderSourcePart[] = [{ kind: "OF", name: payload.ofNumero, sha256: document.pdf_sha256!, id: document.id }, ...annexes.manifest,
                ...supports.map(part => ({ kind: part.kind, name: part.name, sha256: part.sha256 }))];
            const fingerprint = digest(Buffer.from(JSON.stringify(manifest)));
            const existing = await folders.findWorkshopFolderBySource(tx, document.id, fingerprint);
            if (existing) {
                await folders.bindWorkshopFolderPreparation(tx, preparationKey, existing.id, actor.userId!);
                return existing;
            }
            const marks = status === "OFFICIEL" ? ["ORIGINAL", "DUPLICATA", "OBSOLETE"] as const : ["BROUILLON", "OBSOLETE"] as const;
            // Render every required copy before writing the folder. An invalid plan
            // never allocates the first original or leaves a partially ready packet.
            const rendered = [];
            for (const mark of marks)
                rendered.push({ mark, result: await composeWorkshopPackPdf({ number: payload.ofNumero, generatedAt: payload.generatedAt, parts,
                        ofMark: mark === "ORIGINAL" || payload.watermark === mark ? null : mark }) });
            const folder = await folders.insertWorkshopFolder(tx, document, { fingerprint, manifest, preparationKind, actorId: actor.userId!, key: preparationKey });
            for (const copy of rendered) {
                if (copy.result.bytes.length > 52428800)
                    throw new HttpError(422, "WORKSHOP_PACK_LIMIT", "Le dossier dépasse la taille imprimable. Vérifiez ses plans.");
                const archive = await archiveOfDocument(tx, { ofNumero: `${payload.ofNumero} DOSSIER ${copy.mark}`, revisionCode: payload.revisionCode, pieceReference: payload.pieceReference,
                    pdf: copy.result.bytes, pdfSha256: copy.result.sha256, existingGedDocumentId: null, actorUserId: actor.userId, changeReason: "Dossier de fabrication complet" }, owned => { ownership.push(owned); });
                if (!archive.archived || !archive.gedDocumentId || !archive.gedVersionId)
                    throw new HttpError(503, "OF_PRINT_ARCHIVE_REQUIRED", "Le coffre documentaire doit être disponible.");
                await folders.insertWorkshopFolderCopy(tx, { folder_id: folder.id, copy_mark: copy.mark, pdf_sha256: copy.result.sha256, pdf_byte_size: copy.result.bytes.length,
                    page_count: copy.result.pages, page_manifest: copy.result.manifest, ged_document_id: archive.gedDocumentId, ged_version_id: archive.gedVersionId });
            }
            await insertAuditLog(tx, audit, { action: "OF_WORKSHOP_FOLDER_PREPARE", entity_type: "of_document", entity_id: document.id,
                details: { of_id: ofId, folder_id: folder.id, source_fingerprint: fingerprint, parts: manifest.map(part => part.kind), preparation_kind: preparationKind } });
            await folders.bindWorkshopFolderPreparation(tx, preparationKey, folder.id, actor.userId!);
            return folder;
        }, { afterConfirmedRollback: async () => { for (const owned of ownership)
                await compensateOfDocumentArchive(owned); } });
        return { folder: await metadata(result), replayed: false };
    }
    catch (error) {
        if (!(error instanceof documents.OfCommitUncertainError))
            throw error;
        const saved = await folders.findWorkshopFolderByKey(preparationKey);
        if (!saved)
            throw error;
        return { folder: await metadata(saved), replayed: true };
    }
}
export async function previewWorkshopFolder(ofId: number, folderId: string) {
    const folder = await folders.getWorkshopFolder(ofId, folderId);
    if (!folder)
        throw new HttpError(404, "WORKSHOP_FOLDER_NOT_FOUND", "Dossier introuvable sur cet OF.");
    const info = await metadata(folder), mark = info.status !== folder.document_status ? "OBSOLETE" : folder.document_status === "OFFICIEL" ? "ORIGINAL" : folder.document_status;
    const copy = await documents.withOfDocumentReadTransaction(tx => folders.getWorkshopFolderCopy(tx, folderId, mark));
    if (!copy)
        throw copyUnavailable();
    return { pdf: await readCopy(copy), metadata: info };
}
export async function printWorkshopFolder(ofId: number, folderId: string, key: string, actorId: number, audit: AuditContext,
  afterDelivery?: (tx: documents.DbQueryer, intent: OfPrintIntent, folderId: string) => Promise<void>) {
    const folder = await folders.getWorkshopFolder(ofId, folderId);
    if (!folder)
        throw new HttpError(404, "WORKSHOP_FOLDER_NOT_FOUND", "Dossier introuvable sur cet OF.");
    const deliver = async (tx: documents.DbQueryer, intent: OfPrintIntent) => {
        const mark = intent.copy_mark ?? "ORIGINAL";
        const copy = await folders.getWorkshopFolderCopy(tx, folderId, mark);
        if (!copy)
            throw copyUnavailable();
        const pdf = await readCopy(copy); // Still before COMMIT of the accepted ordinal.
        const existing = await folders.getWorkshopFolderPrint(intent.id, tx);
        if (existing && (existing.folder_id !== folderId || existing.copy_mark !== mark))
            throw new HttpError(409, "IDEMPOTENCY_KEY_REUSED", "Cette demande concerne un autre dossier.");
        if (!existing) {
            await folders.insertWorkshopFolderPrint(tx, intent.id, folderId, mark);
            await insertAuditLog(tx, audit, { action: "OF_WORKSHOP_FOLDER_PRINT", entity_type: "of_document", entity_id: folder.document_id,
                details: { of_id: ofId, folder_id: folderId, print_intent_id: intent.id, pdf_sha256: copy.pdf_sha256, physical_print_confirmed: false } });
        }
        await afterDelivery?.(tx, intent, folderId);
        return pdf;
    };
    return requestOfDocumentPrint(ofId, folder.document_id, scopedKey(`print:${folderId}`, key), actorId, audit, { expectedDocumentStatus: folder.document_status,
        deliver, replay: async (intent) => {
            const saved = await folders.getWorkshopFolderPrint(intent.id);
            if (saved?.folder_id !== folderId || saved.copy_mark !== (intent.copy_mark ?? "ORIGINAL"))
                throw copyUnavailable();
            const copy = await documents.withOfDocumentReadTransaction(tx => folders.getWorkshopFolderCopy(tx, folderId, saved.copy_mark));
            if (!copy)
                throw copyUnavailable();
            return readCopy(copy);
        } });
}
