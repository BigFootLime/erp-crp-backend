import type { Request, Response } from "express";
import { asyncHandler } from "../../../utils/asyncHandler";
import * as svc from "../services/project-office-report.service";
import {
  createAssetSchema,
  createErrorRecordSchema,
  createReportSchema,
  createReportVersionSchema,
  createWorkLogSchema,
  entryParamsSchema,
  linkEntryEvidenceSchema,
  listWorkLogsQuerySchema,
  patchEntrySchema,
  patchErrorRecordSchema,
  projectIdParamsSchema,
  uuidParamsSchema,
} from "../validators/project-office.validators";
import { buildAuditContext, requireUser } from "./project-office.controller";

export const getTemplates = asyncHandler(async (_req: Request, res: Response) => {
  res.json(await svc.listTemplates());
});

export const getReports = asyncHandler(async (req: Request, res: Response) => {
  const { id } = projectIdParamsSchema.parse(req.params);
  res.json(await svc.listReports(requireUser(req), id));
});

export const postReport = asyncHandler(async (req: Request, res: Response) => {
  const { id } = projectIdParamsSchema.parse(req.params);
  const body = createReportSchema.parse(req.body);
  res.status(201).json(await svc.createReport(requireUser(req), id, body, buildAuditContext(req)));
});

export const getReport = asyncHandler(async (req: Request, res: Response) => {
  const { id } = uuidParamsSchema.parse(req.params);
  res.json(await svc.getReportDetail(requireUser(req), id));
});

export const getEntry = asyncHandler(async (req: Request, res: Response) => {
  const { id, sectionId } = entryParamsSchema.parse(req.params);
  res.json(await svc.getEntryDetail(requireUser(req), id, sectionId));
});

export const patchEntry = asyncHandler(async (req: Request, res: Response) => {
  const { id, sectionId } = entryParamsSchema.parse(req.params);
  const body = patchEntrySchema.parse(req.body);
  res.json(await svc.patchEntry(requireUser(req), id, sectionId, body, buildAuditContext(req)));
});

export const postEntryGenerate = asyncHandler(async (req: Request, res: Response) => {
  const { id, sectionId } = entryParamsSchema.parse(req.params);
  res.json(await svc.generateEntryDraft(requireUser(req), id, sectionId, "MANUAL_REGENERATE", buildAuditContext(req)));
});

export const postEntryValidate = asyncHandler(async (req: Request, res: Response) => {
  const { id, sectionId } = entryParamsSchema.parse(req.params);
  res.json(await svc.validateEntry(requireUser(req), id, sectionId, buildAuditContext(req)));
});

export const postEntryEvidence = asyncHandler(async (req: Request, res: Response) => {
  const { id, sectionId } = entryParamsSchema.parse(req.params);
  const body = linkEntryEvidenceSchema.parse(req.body);
  res.status(201).json(await svc.linkEntryEvidence(requireUser(req), id, sectionId, body, buildAuditContext(req)));
});

export const postGenerateFull = asyncHandler(async (req: Request, res: Response) => {
  const { id } = uuidParamsSchema.parse(req.params);
  res.json(await svc.generateFullReport(requireUser(req), id, buildAuditContext(req)));
});

export const postReportVersion = asyncHandler(async (req: Request, res: Response) => {
  const { id } = uuidParamsSchema.parse(req.params);
  const body = createReportVersionSchema.parse(req.body);
  res.status(201).json(await svc.createReportVersion(requireUser(req), id, body, buildAuditContext(req)));
});

export const getReportDocx = asyncHandler(async (req: Request, res: Response) => {
  const { id } = uuidParamsSchema.parse(req.params);
  const { filename, buffer } = await svc.exportReportDocx(requireUser(req), id, {}, buildAuditContext(req));
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(buffer);
});

export const getSectionDocx = asyncHandler(async (req: Request, res: Response) => {
  const { id, sectionId } = entryParamsSchema.parse(req.params);
  const { filename, buffer } = await svc.exportReportDocx(requireUser(req), id, { sectionId }, buildAuditContext(req));
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(buffer);
});

export const getReportMarkdown = asyncHandler(async (req: Request, res: Response) => {
  const { id } = uuidParamsSchema.parse(req.params);
  const { filename, markdown } = await svc.exportReportMarkdown(requireUser(req), id, buildAuditContext(req));
  res.setHeader("Content-Type", "text/markdown; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(markdown);
});

export const getExportFile = asyncHandler(async (req: Request, res: Response) => {
  const { id } = uuidParamsSchema.parse(req.params);
  const { buffer, filename, export_type } = await svc.getExportContent(requireUser(req), id);
  const mime =
    export_type === "MARKDOWN" ? "text/markdown; charset=utf-8"
    : export_type === "PDF" ? "application/pdf"
    : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  res.setHeader("Content-Type", mime);
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(buffer);
});

// -------------------------------------------------------------- Journal de travail & erreurs
export const getWorkLogs = asyncHandler(async (req: Request, res: Response) => {
  const { id } = projectIdParamsSchema.parse(req.params);
  const query = listWorkLogsQuerySchema.parse(req.query);
  res.json(await svc.listWorkLogs(requireUser(req), { project_id: id, ...query }));
});

export const postWorkLog = asyncHandler(async (req: Request, res: Response) => {
  const { id } = projectIdParamsSchema.parse(req.params);
  const body = createWorkLogSchema.parse(req.body);
  res.status(201).json(await svc.createWorkLog(requireUser(req), id, body, buildAuditContext(req)));
});

export const getErrors = asyncHandler(async (req: Request, res: Response) => {
  const { id } = projectIdParamsSchema.parse(req.params);
  res.json(await svc.listErrorRecords(requireUser(req), id));
});

export const postError = asyncHandler(async (req: Request, res: Response) => {
  const { id } = projectIdParamsSchema.parse(req.params);
  const body = createErrorRecordSchema.parse(req.body);
  res.status(201).json(await svc.createErrorRecord(requireUser(req), id, body, buildAuditContext(req)));
});

export const patchError = asyncHandler(async (req: Request, res: Response) => {
  const { id } = uuidParamsSchema.parse(req.params);
  const body = patchErrorRecordSchema.parse(req.body);
  res.json(await svc.patchErrorRecord(requireUser(req), id, body, buildAuditContext(req)));
});

// -------------------------------------------------------------- Captures
export const getAssets = asyncHandler(async (req: Request, res: Response) => {
  const { id } = projectIdParamsSchema.parse(req.params);
  const entryId = typeof req.query.report_entry_id === "string" ? req.query.report_entry_id : undefined;
  res.json(await svc.listAssets(requireUser(req), id, entryId));
});

export const postAsset = asyncHandler(async (req: Request, res: Response) => {
  const { id } = projectIdParamsSchema.parse(req.params);
  const meta = createAssetSchema.parse({
    report_entry_id: req.body.report_entry_id || null,
    title: req.body.title,
    description: req.body.description || null,
    asset_type: req.body.asset_type || "SCREENSHOT",
  });
  const file = (req as Request & { file?: { buffer: Buffer; mimetype: string } }).file ?? null;
  res.status(201).json(await svc.createAsset(requireUser(req), id, meta, file, buildAuditContext(req)));
});

export const getAssetContent = asyncHandler(async (req: Request, res: Response) => {
  const { id } = uuidParamsSchema.parse(req.params);
  const { buffer, mime_type } = await svc.getAssetContent(requireUser(req), id);
  res.setHeader("Content-Type", mime_type);
  res.setHeader("Cache-Control", "private, max-age=300");
  res.send(buffer);
});
