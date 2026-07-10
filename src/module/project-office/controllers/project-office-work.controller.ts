import type { Request, Response } from "express";
import { asyncHandler } from "../../../utils/asyncHandler";
import * as svc from "../services/project-office-work.service";
import {
  createCommentSchema,
  createDependencySchema,
  createEvidenceSchema,
  createMilestoneSchema,
  createWorkPackageSchema,
  listWorkPackagesQuerySchema,
  patchMilestoneSchema,
  patchWorkPackageSchema,
  projectIdParamsSchema,
  uuidParamsSchema,
} from "../validators/project-office.validators";
import { buildAuditContext, requireUser } from "./project-office.controller";

export const getWorkPackages = asyncHandler(async (req: Request, res: Response) => {
  const query = listWorkPackagesQuerySchema.parse(req.query);
  res.json(await svc.listWorkPackages(requireUser(req), query));
});

export const postWorkPackage = asyncHandler(async (req: Request, res: Response) => {
  const body = createWorkPackageSchema.parse(req.body);
  res.status(201).json(await svc.createWorkPackage(requireUser(req), body, buildAuditContext(req)));
});

export const getWorkPackage = asyncHandler(async (req: Request, res: Response) => {
  const { id } = uuidParamsSchema.parse(req.params);
  res.json(await svc.getWorkPackageDetail(requireUser(req), id));
});

export const patchWorkPackage = asyncHandler(async (req: Request, res: Response) => {
  const { id } = uuidParamsSchema.parse(req.params);
  const body = patchWorkPackageSchema.parse(req.body);
  res.json(await svc.patchWorkPackage(requireUser(req), id, body, buildAuditContext(req)));
});

export const postComment = asyncHandler(async (req: Request, res: Response) => {
  const { id } = uuidParamsSchema.parse(req.params);
  const { body_markdown } = createCommentSchema.parse(req.body);
  res.status(201).json(await svc.addComment(requireUser(req), id, body_markdown, buildAuditContext(req)));
});

export const getWorkPackageActivity = asyncHandler(async (req: Request, res: Response) => {
  const { id } = uuidParamsSchema.parse(req.params);
  const detail = await svc.getWorkPackageDetail(requireUser(req), id);
  res.json({ items: detail.activity });
});

export const postDependency = asyncHandler(async (req: Request, res: Response) => {
  const { id } = uuidParamsSchema.parse(req.params);
  const body = createDependencySchema.parse(req.body);
  res.status(201).json(await svc.addDependency(requireUser(req), id, body, buildAuditContext(req)));
});

export const postWorkPackageEvidence = asyncHandler(async (req: Request, res: Response) => {
  const { id } = uuidParamsSchema.parse(req.params);
  const body = createEvidenceSchema.parse(req.body);
  res.status(201).json(
    await svc.addEvidenceToWorkPackage(
      requireUser(req), id,
      { type: body.type, title: body.title, url: body.url ?? null, description: body.description ?? null },
      buildAuditContext(req)
    )
  );
});

// -------------------------------------------------------------- Planning
export const getGantt = asyncHandler(async (req: Request, res: Response) => {
  const { id } = projectIdParamsSchema.parse(req.params);
  res.json(await svc.getGanttData(requireUser(req), id));
});

export const getKanban = asyncHandler(async (req: Request, res: Response) => {
  const { id } = projectIdParamsSchema.parse(req.params);
  res.json(await svc.getKanbanData(requireUser(req), id));
});

export const getMilestones = asyncHandler(async (req: Request, res: Response) => {
  const { id } = projectIdParamsSchema.parse(req.params);
  res.json(await svc.listMilestones(requireUser(req), id));
});

export const postMilestone = asyncHandler(async (req: Request, res: Response) => {
  const { id } = projectIdParamsSchema.parse(req.params);
  const body = createMilestoneSchema.parse(req.body);
  res.status(201).json(
    await svc.createMilestone(requireUser(req), id, { name: body.name, description: body.description ?? null, due_date: body.due_date ?? null }, buildAuditContext(req))
  );
});

export const patchMilestone = asyncHandler(async (req: Request, res: Response) => {
  const { id } = uuidParamsSchema.parse(req.params);
  const body = patchMilestoneSchema.parse(req.body);
  res.json(await svc.patchMilestone(requireUser(req), id, body, buildAuditContext(req)));
});
