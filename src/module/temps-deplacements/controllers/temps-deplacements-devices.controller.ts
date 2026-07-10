import type { Request, Response } from "express";
import { asyncHandler } from "../../../utils/asyncHandler";
import * as svc from "../services/temps-deplacements-devices.service";
import {
  badgeBodySchema,
  deviceBodySchema,
  deviceStatusSchema,
  listBadgesQuerySchema,
  uuidParamsSchema,
} from "../validators/temps-deplacements.validators";
import { buildAuditContext, requireUser } from "./temps-deplacements.controller";

// ------------------------------------------------------------------ Bornes
export const getDevices = asyncHandler(async (req: Request, res: Response) => {
  res.json(await svc.listDevices(requireUser(req)));
});
export const postDevice = asyncHandler(async (req: Request, res: Response) => {
  const body = deviceBodySchema.parse(req.body);
  res.status(201).json(await svc.createDevice(requireUser(req), body, buildAuditContext(req))); // { device, token } — token une seule fois
});
export const patchDeviceStatus = asyncHandler(async (req: Request, res: Response) => {
  const { id } = uuidParamsSchema.parse(req.params);
  const { status } = deviceStatusSchema.parse(req.body);
  res.json(await svc.setDeviceStatus(requireUser(req), id, status, buildAuditContext(req)));
});
export const postDeviceRotate = asyncHandler(async (req: Request, res: Response) => {
  const { id } = uuidParamsSchema.parse(req.params);
  res.json(await svc.rotateDeviceToken(requireUser(req), id, buildAuditContext(req)));
});

// ------------------------------------------------------------------ Badges
export const getBadges = asyncHandler(async (req: Request, res: Response) => {
  const { employee_id } = listBadgesQuerySchema.parse(req.query);
  res.json(await svc.listBadges(requireUser(req), employee_id));
});
export const postBadge = asyncHandler(async (req: Request, res: Response) => {
  const body = badgeBodySchema.parse(req.body);
  res.status(201).json(await svc.createBadge(requireUser(req), body, buildAuditContext(req)));
});
export const revokeBadgeHandler = asyncHandler(async (req: Request, res: Response) => {
  const { id } = uuidParamsSchema.parse(req.params);
  res.json(await svc.revokeBadge(requireUser(req), id, buildAuditContext(req)));
});
