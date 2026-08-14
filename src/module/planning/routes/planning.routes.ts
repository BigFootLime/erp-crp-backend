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
  getPlanningExecutionIntelligence,
  getPlanningPreferences,
  putPlanningPreferences,
} from "../controllers/planning.controller";
import { requirePlanningCapability } from "../middlewares/planning-authorization.middleware";
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

router.get("/execution-intelligence", requirePlanningCapability("read_capacity"), getPlanningExecutionIntelligence);
router.get("/preferences", requirePlanningCapability("manage_preferences"), getPlanningPreferences);
router.put("/preferences", requirePlanningCapability("manage_preferences"), putPlanningPreferences);

router.get("/resources", requirePlanningCapability("read"), listPlanningResources);
router.get("/events", requirePlanningCapability("read"), listPlanningEvents);
router.post("/autoplan", requirePlanningCapability("manage_schedule"), autoPlanPlanning);
router.post("/validate-for-ar", requirePlanningCapability("manage_schedule"), validatePlanningForAr);
router.post("/events", requirePlanningCapability("manage_schedule"), createPlanningEvent);
router.get("/events/:id", requirePlanningCapability("read"), getPlanningEvent);
router.patch("/events/:id", requirePlanningCapability("manage_schedule"), patchPlanningEvent);
router.delete("/events/:id", requirePlanningCapability("manage_schedule"), archivePlanningEvent);
router.post("/events/:id/restore", requirePlanningCapability("manage_schedule"), restorePlanningEvent);
router.post("/events/:id/comments", requirePlanningCapability("manage_schedule"), createPlanningEventComment);

router.post("/events/:id/documents", requirePlanningCapability("manage_schedule"), uploadDocs.array("documents[]"), uploadPlanningEventDocuments);
router.get("/events/:id/documents/:docId/file", requirePlanningCapability("read"), getPlanningEventDocumentFile);

export default router;
