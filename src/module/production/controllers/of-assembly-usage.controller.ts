import { listAssemblyUsage } from "../repository/of-assembly-usage.repository";
import { asyncHandler } from "../../../utils/asyncHandler";
import { ofIdParamSchema } from "../validators/production.validators";

export const ofAssemblyUsage = asyncHandler(async (req, res) => {
  const { id } = ofIdParamSchema.parse({ params: req.params }).params;
  res.setHeader("Cache-Control", "no-store");
  res.json({ items: await listAssemblyUsage(id) });
});
