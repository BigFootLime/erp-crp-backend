import type { Request, Response } from "express";
import { asyncHandler } from "../../../utils/asyncHandler";
import * as svc from "../services/temps-deplacements-km.service";
import {
  createKmSchema,
  myKmQuerySchema,
  teamKmQuerySchema,
  uuidParamsSchema,
  vehicleBodySchema,
} from "../validators/temps-deplacements.validators";
import { buildAuditContext, requireUser } from "./temps-deplacements.controller";

// ------------------------------------------------------------------ Salarié (self-service)
export const postKm = asyncHandler(async (req: Request, res: Response) => {
  const body = createKmSchema.parse(req.body);
  const entry = await svc.createMyKmEntry(requireUser(req), body, buildAuditContext(req));
  res.status(201).json(entry);
});
export const getMyKm = asyncHandler(async (req: Request, res: Response) => {
  const filters = myKmQuerySchema.parse(req.query);
  res.json(await svc.listMyKmEntries(requireUser(req), filters));
});
export const submitKm = asyncHandler(async (req: Request, res: Response) => {
  const { id } = uuidParamsSchema.parse(req.params);
  res.json(await svc.submitMyKmEntry(requireUser(req), id, buildAuditContext(req)));
});

// ------------------------------------------------------------------ Responsable
export const getTeamKm = asyncHandler(async (req: Request, res: Response) => {
  const { status } = teamKmQuerySchema.parse(req.query);
  res.json(await svc.listTeamKmEntries(requireUser(req), status));
});
export const validateKm = asyncHandler(async (req: Request, res: Response) => {
  const { id } = uuidParamsSchema.parse(req.params);
  res.json(await svc.decideKmEntry(requireUser(req), id, "VALIDATED", buildAuditContext(req)));
});
export const rejectKm = asyncHandler(async (req: Request, res: Response) => {
  const { id } = uuidParamsSchema.parse(req.params);
  res.json(await svc.decideKmEntry(requireUser(req), id, "REJECTED", buildAuditContext(req)));
});

// ------------------------------------------------------------------ Véhicules
export const getVehicles = asyncHandler(async (req: Request, res: Response) => {
  requireUser(req);
  res.json(await svc.listVehicles());
});
export const postVehicle = asyncHandler(async (req: Request, res: Response) => {
  const body = vehicleBodySchema.parse(req.body);
  res.status(201).json(await svc.createVehicle(requireUser(req), body, buildAuditContext(req)));
});
