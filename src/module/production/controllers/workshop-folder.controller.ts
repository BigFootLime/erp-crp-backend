import type { Request, Response } from "express";
import { asyncHandler } from "../../../utils/asyncHandler";
import { HttpError } from "../../../utils/httpError";
import { buildContentDisposition } from "../../../shared/uploads/secure-download";
import { buildAuditContext } from "../../project-office/controllers/project-office.controller";
import { idempotencyKeyOf } from "../middlewares/of-versioning-authorization.middleware";
import { ofIdParam } from "../validators/of-versioning.validators";
import { workshopFolderParams as folderParams, workshopFolderCommand as emptyCommand } from "../validators/workshop-folder.validators";
import { prepareWorkshopFolder, previewWorkshopFolder, printWorkshopFolder } from "../services/workshop-folder.service";
import type { OfActor } from "../services/of-versioning.service";
import { printResponseContext, setWorkshopPrintHeaders } from "./workshop-print-response";
function actor(req: Request): OfActor {
    if (!req.user || typeof req.user.id !== "number")
        throw new HttpError(401, "UNAUTHORIZED", "Authentification requise.");
    return { userId: req.user.id, username: req.user.username ?? `#${req.user.id}`, role: req.user.role ?? null };
}
function key(req: Request) {
    const value = idempotencyKeyOf(req);
    if (!value)
        throw new HttpError(400, "IDEMPOTENCY_KEY_REQUIRED", "La demande doit être identifiée.");
    return value;
}
function pdfResponse(res: Response, pdf: Buffer, filename: string) {
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Length", String(pdf.length));
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Content-Disposition", buildContentDisposition(filename, false));
    res.end(pdf);
}
export const prepareFolder = asyncHandler(async (req: Request, res: Response) => {
    const { ofId } = ofIdParam.parse(req.params);
    emptyCommand.parse(req.body ?? {});
    const result = await prepareWorkshopFolder(ofId, key(req), actor(req), buildAuditContext(req));
    res.status(result.replayed ? 200 : 201).json(result);
});
export const previewFolder = asyncHandler(async (req: Request, res: Response) => {
    const { ofId, folderId } = folderParams.parse(req.params);
    const result = await previewWorkshopFolder(ofId, folderId);
    pdfResponse(res, result.pdf, `DOSSIER-OF-${ofId}.pdf`);
});
export const printFolder = asyncHandler(async (req: Request, res: Response) => {
    const { ofId, folderId } = folderParams.parse(req.params);
    emptyCommand.parse(req.body ?? {});
    const database = await printResponseContext();
    const result = await printWorkshopFolder(ofId, folderId, key(req), actor(req).userId!, buildAuditContext(req));
    setWorkshopPrintHeaders(res, database, result.intent.actor_id, result.intent.id, result.intent.copy_mark, result.pdf);
    pdfResponse(res, result.pdf, `DOSSIER-OF-${ofId}-${result.intent.copy_mark ?? "ORIGINAL"}.pdf`);
});
