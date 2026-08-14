import type { Request, Response } from "express";
import { asyncHandler } from "../../../utils/asyncHandler";
import * as service from "../services/project-office-operations.service";
import {
  createProjectBudgetSchema,
  linkProjectAffaireSchema,
  projectAffaireLinkParamsSchema,
  projectIdParamsSchema,
} from "../validators/project-office.validators";
import { buildAuditContext, requireUser } from "./project-office.controller";

export const getOperations = asyncHandler(async (req: Request, res: Response) => {
  const { id } = projectIdParamsSchema.parse(req.params);
  res.json(await service.getProjectOperations(requireUser(req), id));
});

export const postBudget = asyncHandler(async (req: Request, res: Response) => {
  const { id } = projectIdParamsSchema.parse(req.params);
  const input = createProjectBudgetSchema.parse(req.body);
  res.status(201).json(await service.createProjectBudget(requireUser(req), id, input, buildAuditContext(req)));
});

export const postAffaireLink = asyncHandler(async (req: Request, res: Response) => {
  const { id } = projectIdParamsSchema.parse(req.params);
  const input = linkProjectAffaireSchema.parse(req.body);
  res.status(201).json(await service.linkProjectAffaire(requireUser(req), id, input, buildAuditContext(req)));
});

export const deleteAffaireLink = asyncHandler(async (req: Request, res: Response) => {
  const { id, linkId } = projectAffaireLinkParamsSchema.parse(req.params);
  res.json(await service.unlinkProjectAffaire(requireUser(req), id, linkId, buildAuditContext(req)));
});
