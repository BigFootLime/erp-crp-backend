import { asyncHandler } from "../../../utils/asyncHandler";
import { svcGetPlanningReferenceOf, svcListPlanningReferenceOfs } from "../services/planning-references.service";
import { planningReferenceOfListQuerySchema, planningReferenceOfParamSchema } from "../validators/planning-references.validators";
export const listPlanningReferenceOfs = asyncHandler(async (req, res) => {
  res.setHeader("Cache-Control", "private, no-store");
  res.json(await svcListPlanningReferenceOfs(planningReferenceOfListQuerySchema.parse(req.query)));
});
export const getPlanningReferenceOf = asyncHandler(async (req, res) => {
  const { id } = planningReferenceOfParamSchema.parse({ params: req.params }).params;
  const out = await svcGetPlanningReferenceOf(id);
  if (!out) { res.status(404).json({ error: "Not found" }); return; }
  res.setHeader("Cache-Control", "private, no-store");
  res.json(out);
});
