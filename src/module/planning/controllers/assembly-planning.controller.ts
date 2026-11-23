import { asyncHandler } from "../../../utils/asyncHandler";
import { requestHasElevatedAccountModuleAccess } from "../../access-control/context/account-module-access.context";
import { roleHasPlanningCapability } from "../domain/planning-rbac";
import { getAssemblyWeek, saveAssemblyWeek } from "../services/assembly-planning.service";
import { saveSchema, weekSchema } from "../validators/assembly-planning.validators";

export const getAssemblyPlanning = asyncHandler(async (req, res) => {
  const week = weekSchema.parse(req.query.week);
  const canManage = requestHasElevatedAccountModuleAccess(req) || roleHasPlanningCapability(req.user?.role, "manage_schedule");
  res.setHeader("Cache-Control", "no-store");
  res.json(await getAssemblyWeek(week, canManage));
});

export const saveAssemblyPlanning = asyncHandler(async (req, res) => {
  await saveAssemblyWeek(saveSchema.parse(req.body), req.user?.id ?? null);
  res.status(204).end();
});
