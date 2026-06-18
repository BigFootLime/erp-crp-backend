import type { RequestHandler } from "express";

import { asyncHandler } from "../../../utils/asyncHandler";
import { listAssignableUsers } from "../services/users.service";
import { listAssignableUsersQuerySchema } from "../validators/users.validators";

export const listAssignableUsersController: RequestHandler = asyncHandler(async (req, res) => {
  const query = listAssignableUsersQuerySchema.parse(req.query);
  const items = await listAssignableUsers({ q: query.q, role: query.role, limit: query.limit });
  res.json({ items });
});
