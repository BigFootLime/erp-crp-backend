import { Router, type RequestHandler } from "express";
import { requestHasGrantedAccountModuleAccess } from "../../access-control/context/account-module-access.context";
import { authenticateToken } from "../../auth/middlewares/auth.middleware";
import { createSecureUpload } from "../../../shared/uploads/secure-upload";
import { HttpError } from "../../../utils/httpError";
import { roleHasPlanningAccess } from "../domain/planning-rbac";
import { requireSuperadmin } from "../../access-control/middlewares/require-superadmin";
import {
  archivePlanningEvent,
  autoPlanPlanning,
  createPlanningEvent,
  createPlanningEventComment,
  getPlanningEvent,
  getPlanningEventDocumentFile,
  healthPlanning,
  listPlanningEvents,
  listPlanningResources,
  patchPlanningEvent,
  restorePlanningEvent,
  uploadPlanningEventDocuments,
  validatePlanningForAr,
} from "../controllers/planning.controller";
import {
  getPlanningConvergence,
  getPlanningUsageMetrics,
  postPlanningUsage,
} from "../controllers/planning-convergence.controller";

const requireProductionOrAdmin: RequestHandler = (req, _res, next) => {
  const role = req.user?.role;
  if (
    !requestHasGrantedAccountModuleAccess(req) &&
    !roleHasPlanningAccess(role)
  ) {
    next(new HttpError(403, "FORBIDDEN", "Production, atelier, secretariat or admin role required"));
    return;
  }
  next();
};

const uploadDocs = createSecureUpload("business-document");

const router = Router();

router.use(authenticateToken);
router.use(requireProductionOrAdmin);

router.get("/health", healthPlanning);

// Convergence du board Premium / dashboard historique. La decision NO-GO et
// le flag OFF conservent le board historique; les metriques sont agregees.
router.get("/governance", getPlanningConvergence);
router.post("/governance/usage", postPlanningUsage);
router.get("/governance/metrics", requireSuperadmin, getPlanningUsageMetrics);

router.get("/resources", listPlanningResources);
router.get("/events", listPlanningEvents);
router.post("/autoplan", autoPlanPlanning);
router.post("/validate-for-ar", validatePlanningForAr);
router.post("/events", createPlanningEvent);
router.get("/events/:id", getPlanningEvent);
router.patch("/events/:id", patchPlanningEvent);
router.delete("/events/:id", archivePlanningEvent);
router.post("/events/:id/restore", restorePlanningEvent);
router.post("/events/:id/comments", createPlanningEventComment);

router.post("/events/:id/documents", uploadDocs.array("documents[]"), uploadPlanningEventDocuments);
router.get("/events/:id/documents/:docId/file", getPlanningEventDocumentFile);

export default router;
