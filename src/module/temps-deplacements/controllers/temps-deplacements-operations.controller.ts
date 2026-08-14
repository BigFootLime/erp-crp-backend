import type { Request, Response } from "express";
import { asyncHandler } from "../../../utils/asyncHandler";
import * as service from "../services/temps-deplacements-operations.service";
import {
  absenceStatusQuerySchema,
  createAbsenceSchema,
  createKilometerRateSchema,
  createPeriodClosureSchema,
  uuidParamsSchema,
} from "../validators/temps-deplacements.validators";
import { buildAuditContext, requireUser } from "./temps-deplacements.controller";

export const postAbsence = asyncHandler(async (req: Request, res: Response) => {
  const input = createAbsenceSchema.parse(req.body);
  res.status(201).json(await service.createMyAbsence(requireUser(req), input, buildAuditContext(req)));
});

export const getMyAbsences = asyncHandler(async (req: Request, res: Response) => {
  res.json(await service.listMyAbsences(requireUser(req)));
});

export const getTeamAbsences = asyncHandler(async (req: Request, res: Response) => {
  const { status } = absenceStatusQuerySchema.parse(req.query);
  res.json(await service.listTeamAbsences(requireUser(req), status));
});

export const approveAbsence = asyncHandler(async (req: Request, res: Response) => {
  const { id } = uuidParamsSchema.parse(req.params);
  res.json(await service.decideAbsence(requireUser(req), id, "APPROVED", buildAuditContext(req)));
});

export const rejectAbsence = asyncHandler(async (req: Request, res: Response) => {
  const { id } = uuidParamsSchema.parse(req.params);
  res.json(await service.decideAbsence(requireUser(req), id, "REJECTED", buildAuditContext(req)));
});

export const getOperationsQueue = asyncHandler(async (req: Request, res: Response) => {
  res.json(await service.getOperationsQueue(requireUser(req)));
});

export const getClosures = asyncHandler(async (req: Request, res: Response) => {
  res.json(await service.listClosures(requireUser(req)));
});

export const postClosure = asyncHandler(async (req: Request, res: Response) => {
  const input = createPeriodClosureSchema.parse(req.body);
  res.status(201).json(await service.createPeriodClosure(requireUser(req), input, buildAuditContext(req)));
});

export const reopenClosure = asyncHandler(async (req: Request, res: Response) => {
  const { id } = uuidParamsSchema.parse(req.params);
  res.json(await service.reopenPeriodClosure(requireUser(req), id, buildAuditContext(req)));
});

export const getKilometerRates = asyncHandler(async (req: Request, res: Response) => {
  res.json(await service.listKilometerRates(requireUser(req)));
});

export const postKilometerRate = asyncHandler(async (req: Request, res: Response) => {
  const input = createKilometerRateSchema.parse(req.body);
  res.status(201).json(await service.createKilometerRate(requireUser(req), input, buildAuditContext(req)));
});
