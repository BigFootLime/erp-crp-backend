import { Router, type RequestHandler } from "express";
import {
  requestHasGrantedAccountModuleAccess,
} from "../../access-control/context/account-module-access.context";
import { authenticateToken } from "../../auth/middlewares/auth.middleware";
import { HttpError } from "../../../utils/httpError";
import { roleHasPlanningAccess } from "../../planning/domain/planning-rbac";
import {
  cancelProgrammationReschedule,
  commitProgrammationReschedule,
  healthProgrammations,
  listProgrammations,
  previewProgrammationReschedule,
} from "../controllers/programmation.controller";

const requireProductionOrAdmin: RequestHandler = (req, _res, next) => {
  if (
    requestHasGrantedAccountModuleAccess(req) ||
    roleHasPlanningAccess(req.user?.role)
  ) {
    next();
    return;
  }
  next(new HttpError(403, "FORBIDDEN", "Production, planning, atelier, secretariat or admin role required"));
};

const router = Router();

router.use(authenticateToken);
router.use(requireProductionOrAdmin);

router.get("/health", healthProgrammations);
router.get("/", listProgrammations);
router.post("/:id/reschedule/preview", previewProgrammationReschedule);
router.post("/:id/reschedule/commit", commitProgrammationReschedule);
router.post("/:id/reschedule/:operationId/cancel", cancelProgrammationReschedule);

export default router;
