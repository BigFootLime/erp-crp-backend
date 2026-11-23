import { listAssemblyUsage } from "../repository/assembly-usage.repository";
import { asyncHandler } from "../../../utils/asyncHandler";
import { idParamSchema } from "../validators/pieces-techniques.validators";

export const pieceAssemblyUsage = asyncHandler(async (req, res) => {
  const { id } = idParamSchema.parse({ params: req.params }).params;
  res.setHeader("Cache-Control", "no-store");
  res.json({ items: await listAssemblyUsage(id) });
});
