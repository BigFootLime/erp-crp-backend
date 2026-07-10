import type { Request, Response } from "express";
import { asyncHandler } from "../../../utils/asyncHandler";
import * as svc from "../services/temps-deplacements-corrections.service";
import {
  createAdjustmentSchema,
  teamAnomaliesQuerySchema,
  uuidParamsSchema,
} from "../validators/temps-deplacements.validators";
import { buildAuditContext, requireUser } from "./temps-deplacements.controller";

// ------------------------------------------------------------------ Corrections (salarié + responsable)
export const postAdjustment = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireUser(req);
  const body = createAdjustmentSchema.parse(req.body);
  const adj = await svc.createAdjustment(actor, body, buildAuditContext(req));
  res.status(201).json(adj);
});

export const approveAdjustment = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireUser(req);
  const { id } = uuidParamsSchema.parse(req.params);
  const adj = await svc.decideAdjustment(actor, id, "APPROVED", buildAuditContext(req));
  res.json(adj);
});

export const rejectAdjustment = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireUser(req);
  const { id } = uuidParamsSchema.parse(req.params);
  const adj = await svc.decideAdjustment(actor, id, "REJECTED", buildAuditContext(req));
  res.json(adj);
});

export const getTeamAdjustments = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireUser(req);
  res.json(await svc.listTeamAdjustments(actor));
});

// ------------------------------------------------------------------ Validation jour / semaine
export const validateDay = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireUser(req);
  const { id } = uuidParamsSchema.parse(req.params);
  res.json(await svc.validateTimesheetDay(actor, id, buildAuditContext(req)));
});

export const validateWeek = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireUser(req);
  const { id } = uuidParamsSchema.parse(req.params);
  res.json(await svc.validateTimesheetWeek(actor, id, buildAuditContext(req)));
});

// ------------------------------------------------------------------ Périmètre équipe (lecture)
export const getTeamToday = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireUser(req);
  res.json(await svc.teamToday(actor));
});

export const getTeamAnomalies = asyncHandler(async (req: Request, res: Response) => {
  const actor = requireUser(req);
  const { date } = teamAnomaliesQuerySchema.parse(req.query);
  res.json(await svc.teamAnomalies(actor, date));
});
