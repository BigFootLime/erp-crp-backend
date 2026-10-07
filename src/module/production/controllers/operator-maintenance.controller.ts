import type { Request } from "express";
import { z } from "zod";
import { HttpError } from "../../../utils/httpError";
import { asyncHandler } from "../../../utils/asyncHandler";
import {
  maintenanceWorkspace,
  maintenanceWrite,
} from "../services/operator-maintenance.service";
function context(req: Request) {
  const id = z.string().uuid().safeParse(req.params.id);
  if (!id.success)
    throw new HttpError(
      422,
      "MACHINE_ID_INVALID",
      "Identifiant machine invalide.",
    );
  if (!req.user?.id)
    throw new HttpError(401, "UNAUTHORIZED", "Authentification requise.");
  return {
    machineId: id.data,
    actor: req.user.id,
    roles: [req.user.role, req.user.primary_role, ...(req.user.roles ?? [])],
  };
}
export const readOperatorMaintenance = asyncHandler(async (req, res) => {
  const c = context(req);
  res.json({ data: await maintenanceWorkspace(c.machineId, c.actor, c.roles) });
});
export const writeOperatorMaintenance = asyncHandler(async (req, res) => {
  const c = context(req);
  res
    .status(201)
    .json({
      data: await maintenanceWrite(c.machineId, c.actor, c.roles, req.body),
    });
});
