import { asyncHandler } from "../../../utils/asyncHandler";
import { buildAuditContext } from "./planning.controller";
import { planningClientColorSchema } from "../validators/planning-client-color.validators";
import { svcListPlanningClientColors, svcSetPlanningClientColor } from "../services/planning-client-color.service";
export const listPlanningClientColors = asyncHandler(async (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(await svcListPlanningClientColors());
});
export const setPlanningClientColor = asyncHandler(async (req, res) => {
  const input = planningClientColorSchema.parse({ params: req.params, body: req.body });
  const out = await svcSetPlanningClientColor(input.params.clientId, input.body.color, buildAuditContext(req));
  res.setHeader("Cache-Control", "no-store");
  res.json(out);
});
