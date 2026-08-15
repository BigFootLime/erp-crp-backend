import type { RequestHandler } from "express";

import { asyncHandler } from "../../../utils/asyncHandler";
import { getOperationsConsoleSnapshot } from "../services/operations-console.service";

export const getOperationsConsole: RequestHandler = asyncHandler(async (_req, res) => {
  res.setHeader("Cache-Control", "private, no-store");
  res.json(await getOperationsConsoleSnapshot());
});
