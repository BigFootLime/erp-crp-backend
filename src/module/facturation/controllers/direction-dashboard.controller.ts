import type { RequestHandler } from "express";

import { HttpError } from "../../../utils/httpError";
import {
  getDirectionDashboard,
  resolveDirectionRequest,
} from "../services/direction-dashboard.service";
import { directionDashboardQuerySchema } from "../validators/direction-dashboard.validators";

export const directionDashboardOverview: RequestHandler = async (req, res, next) => {
  try {
    if (!req.user) {
      throw new HttpError(401, "UNAUTHORIZED", "Authentification requise.");
    }
    const query = directionDashboardQuerySchema.parse(req.query);
    const request = resolveDirectionRequest(query);
    res.setHeader("Cache-Control", "no-store, private");
    res.json(await getDirectionDashboard(request));
  } catch (error) {
    next(error);
  }
};
