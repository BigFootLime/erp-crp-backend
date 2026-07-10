import type { Request, Response } from "express";
import { asyncHandler } from "../../../utils/asyncHandler";
import * as svc from "../services/project-office-projects.service";
import {
  addMemberSchema,
  createProjectSchema,
  listProjectsQuerySchema,
  memberParamsSchema,
  patchProjectSchema,
  projectIdParamsSchema,
} from "../validators/project-office.validators";
import { buildAuditContext, requireUser } from "./project-office.controller";

export const getProjects = asyncHandler(async (req: Request, res: Response) => {
  const query = listProjectsQuerySchema.parse(req.query);
  res.json(await svc.listProjects(requireUser(req), query));
});

export const postProject = asyncHandler(async (req: Request, res: Response) => {
  const body = createProjectSchema.parse(req.body);
  res.status(201).json(await svc.createProject(requireUser(req), body, buildAuditContext(req)));
});

export const getProject = asyncHandler(async (req: Request, res: Response) => {
  const { id } = projectIdParamsSchema.parse(req.params);
  res.json(await svc.getProjectDetail(requireUser(req), id));
});

export const patchProject = asyncHandler(async (req: Request, res: Response) => {
  const { id } = projectIdParamsSchema.parse(req.params);
  const body = patchProjectSchema.parse(req.body);
  res.json(await svc.patchProject(requireUser(req), id, body, buildAuditContext(req)));
});

export const postMember = asyncHandler(async (req: Request, res: Response) => {
  const { id } = projectIdParamsSchema.parse(req.params);
  const body = addMemberSchema.parse(req.body);
  res.status(201).json(await svc.addMember(requireUser(req), id, body, buildAuditContext(req)));
});

export const deleteMember = asyncHandler(async (req: Request, res: Response) => {
  const { id, userId } = memberParamsSchema.parse(req.params);
  res.json(await svc.removeMember(requireUser(req), id, userId, buildAuditContext(req)));
});
