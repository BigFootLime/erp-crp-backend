import type { Request, Response } from "express";
import { asyncHandler } from "../../../utils/asyncHandler";
import * as svc from "../services/temps-deplacements-exports.service";
import { exportBodySchema, uuidParamsSchema } from "../validators/temps-deplacements.validators";
import { buildAuditContext, requireUser } from "./temps-deplacements.controller";

export const postExport = asyncHandler(async (req: Request, res: Response) => {
  const body = exportBodySchema.parse(req.body);
  const batch = await svc.createExport(requireUser(req), body, buildAuditContext(req));
  res.status(201).json(batch);
});

export const getExports = asyncHandler(async (req: Request, res: Response) => {
  res.json(await svc.listExports(requireUser(req)));
});

// Télécharge les octets FIGÉS + expose le checksum (intégrité vérifiée côté service).
export const downloadExport = asyncHandler(async (req: Request, res: Response) => {
  const { id } = uuidParamsSchema.parse(req.params);
  const file = await svc.getExportFile(requireUser(req), id);
  res.setHeader("Content-Type", file.contentType);
  res.setHeader("Content-Disposition", `attachment; filename="${file.filename}"`);
  res.setHeader("X-Checksum-SHA256", file.checksum);
  res.send(file.buffer);
});
