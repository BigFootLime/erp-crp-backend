import type { Request, Response } from "express";
import { asyncHandler } from "../../../utils/asyncHandler";
import * as reg from "../services/project-office-registers.service";
import * as status from "../services/project-office-status.service";
import {
  createActionSchema,
  createDecisionSchema,
  createEvidenceSchema,
  createEvidenceFileSchema,
  evidenceFileContentQuerySchema,
  evidenceFilesQuerySchema,
  createExternalLinkSchema,
  createRiskSchema,
  createSpecSchema,
  createSpecVersionSchema,
  paginationQuerySchema,
  patchActionSchema,
  patchRiskSchema,
  patchSpecStatusSchema,
  projectIdParamsSchema,
  projectEvidenceFileContentParamsSchema,
  uuidParamsSchema,
} from "../validators/project-office.validators";
import { buildAuditContext, requireUser } from "./project-office.controller";

// -------------------------------------------------------------- Specs
export const getSpecs = asyncHandler(async (req: Request, res: Response) => {
  const { id } = projectIdParamsSchema.parse(req.params);
  res.json(await reg.listSpecs(requireUser(req), id));
});

export const postSpec = asyncHandler(async (req: Request, res: Response) => {
  const { id } = projectIdParamsSchema.parse(req.params);
  const body = createSpecSchema.parse(req.body);
  res.status(201).json(await reg.createSpec(requireUser(req), id, body, buildAuditContext(req)));
});

export const getSpec = asyncHandler(async (req: Request, res: Response) => {
  const { id } = uuidParamsSchema.parse(req.params);
  res.json(await reg.getSpecDetail(requireUser(req), id));
});

export const postSpecVersion = asyncHandler(async (req: Request, res: Response) => {
  const { id } = uuidParamsSchema.parse(req.params);
  const body = createSpecVersionSchema.parse(req.body);
  res.status(201).json(await reg.createSpecVersion(requireUser(req), id, body, buildAuditContext(req)));
});

export const patchSpecStatus = asyncHandler(async (req: Request, res: Response) => {
  const { id } = uuidParamsSchema.parse(req.params);
  const { status: next } = patchSpecStatusSchema.parse(req.body);
  res.json(await reg.patchSpecStatus(requireUser(req), id, next, buildAuditContext(req)));
});

export const postSpecApprove = asyncHandler(async (req: Request, res: Response) => {
  const { id } = uuidParamsSchema.parse(req.params);
  res.json(await reg.approveSpec(requireUser(req), id, buildAuditContext(req)));
});

// -------------------------------------------------------------- Décisions
export const getDecisions = asyncHandler(async (req: Request, res: Response) => {
  const { id } = projectIdParamsSchema.parse(req.params);
  res.json(await reg.listDecisions(requireUser(req), id));
});

export const postDecision = asyncHandler(async (req: Request, res: Response) => {
  const { id } = projectIdParamsSchema.parse(req.params);
  const body = createDecisionSchema.parse(req.body);
  res.status(201).json(await reg.createDecision(requireUser(req), id, body, buildAuditContext(req)));
});

// -------------------------------------------------------------- Risques
export const getRisks = asyncHandler(async (req: Request, res: Response) => {
  const { id } = projectIdParamsSchema.parse(req.params);
  res.json(await reg.listRisks(requireUser(req), id));
});

export const postRisk = asyncHandler(async (req: Request, res: Response) => {
  const { id } = projectIdParamsSchema.parse(req.params);
  const body = createRiskSchema.parse(req.body);
  res.status(201).json(await reg.createRisk(requireUser(req), id, body, buildAuditContext(req)));
});

export const patchRisk = asyncHandler(async (req: Request, res: Response) => {
  const { id } = uuidParamsSchema.parse(req.params);
  const body = patchRiskSchema.parse(req.body);
  res.json(await reg.patchRisk(requireUser(req), id, body, buildAuditContext(req)));
});

// -------------------------------------------------------------- Actions
export const getActions = asyncHandler(async (req: Request, res: Response) => {
  const { id } = projectIdParamsSchema.parse(req.params);
  res.json(await reg.listActions(requireUser(req), id));
});

export const postAction = asyncHandler(async (req: Request, res: Response) => {
  const { id } = projectIdParamsSchema.parse(req.params);
  const body = createActionSchema.parse(req.body);
  res.status(201).json(await reg.createAction(requireUser(req), id, body, buildAuditContext(req)));
});

export const patchAction = asyncHandler(async (req: Request, res: Response) => {
  const { id } = uuidParamsSchema.parse(req.params);
  const body = patchActionSchema.parse(req.body);
  res.json(await reg.patchAction(requireUser(req), id, body, buildAuditContext(req)));
});

// -------------------------------------------------------------- Preuves & liens
export const getEvidence = asyncHandler(async (req: Request, res: Response) => {
  const { id } = projectIdParamsSchema.parse(req.params);
  const { page, pageSize } = paginationQuerySchema.parse(req.query);
  res.json(await reg.listEvidence(requireUser(req), { project_id: id, page, pageSize }));
});

export const postEvidence = asyncHandler(async (req: Request, res: Response) => {
  const { id } = projectIdParamsSchema.parse(req.params);
  const body = createEvidenceSchema.parse(req.body);
  res.status(201).json(await reg.createEvidence(requireUser(req), id, body, buildAuditContext(req)));
});

export const postEvidenceFile = asyncHandler(async (req: Request, res: Response) => {
  const { id } = projectIdParamsSchema.parse(req.params);
  const body = createEvidenceFileSchema.parse(req.body);
  const result = await reg.uploadEvidenceFile(requireUser(req), id, body, req.file, buildAuditContext(req));
  res.status(201).json({
    ...result,
    download_url: `/api/v1/project-office/evidence-files/${result.file.id}/download`,
    content_url: `/api/v1/project-office/projects/${id}/evidence-files/${result.file.id}/content`,
  });
});

export const getEvidenceFiles = asyncHandler(async (req: Request, res: Response) => {
  const { id } = projectIdParamsSchema.parse(req.params);
  const { page, pageSize, category } = evidenceFilesQuerySchema.parse(req.query);
  res.json(await reg.listEvidenceFiles(requireUser(req), { project_id: id, category, page, pageSize }));
});

export const getProjectEvidenceFileContent = asyncHandler(async (req: Request, res: Response) => {
  const { projectId, id } = projectEvidenceFileContentParamsSchema.parse(req.params);
  const { disposition } = evidenceFileContentQuerySchema.parse(req.query);
  const file = await reg.downloadProjectEvidenceFile(requireUser(req), projectId, id);
  const safeName = file.original_name.replace(/["\\\r\n]/g, "_");
  res.setHeader("Content-Type", file.mime_type);
  res.setHeader("Content-Length", String(file.buffer.byteLength));
  res.setHeader("Content-Disposition", `${disposition}; filename="${safeName}"`);
  res.send(file.buffer);
});

export const getEvidenceFileDownload = asyncHandler(async (req: Request, res: Response) => {
  const { id } = uuidParamsSchema.parse(req.params);
  const file = await reg.downloadEvidenceFile(requireUser(req), id);
  const safeName = file.original_name.replace(/["\\\r\n]/g, "_");
  res.setHeader("Content-Type", file.mime_type);
  res.setHeader("Content-Length", String(file.size_bytes));
  res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);
  res.send(file.buffer);
});

export const getExternalLinks = asyncHandler(async (req: Request, res: Response) => {
  const { id } = projectIdParamsSchema.parse(req.params);
  res.json(await reg.listExternalLinks(requireUser(req), id));
});

export const postExternalLink = asyncHandler(async (req: Request, res: Response) => {
  const body = createExternalLinkSchema.parse(req.body);
  res.status(201).json(await reg.createExternalLink(requireUser(req), body, buildAuditContext(req)));
});

// -------------------------------------------------------------- Rapport de statut
export const getStatusReport = asyncHandler(async (req: Request, res: Response) => {
  const { id } = projectIdParamsSchema.parse(req.params);
  res.json(await status.buildStatusReport(requireUser(req), id));
});

export const getStatusReportMarkdown = asyncHandler(async (req: Request, res: Response) => {
  const { id } = projectIdParamsSchema.parse(req.params);
  const report = await status.buildStatusReport(requireUser(req), id);
  const md = status.statusReportToMarkdown(report);
  res.setHeader("Content-Type", "text/markdown; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="statut-${report.project.code.toLowerCase()}.md"`);
  res.send(md);
});

export const getStatusReportPdf = asyncHandler(async (req: Request, res: Response) => {
  const { id } = projectIdParamsSchema.parse(req.params);
  const report = await status.buildStatusReport(requireUser(req), id);
  const pdf = await status.statusReportToPdf(report);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="statut-${report.project.code.toLowerCase()}.pdf"`);
  res.send(pdf);
});
