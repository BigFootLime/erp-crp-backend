import { Router, type RequestHandler } from "express";
import multer from "multer";
import { authenticateToken } from "../../auth/middlewares/auth.middleware";
import { ensureDocumentStoragePath } from "../../../utils/cerpStorage";
import { HttpError } from "../../../utils/httpError";
import { roleHasPlanningAccess } from "../domain/planning-rbac";
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

const requireProductionOrAdmin: RequestHandler = (req, _res, next) => {
  const role = req.user?.role;
  if (!roleHasPlanningAccess(role)) {
    next(new HttpError(403, "FORBIDDEN", "Production, atelier, secretariat or admin role required"));
    return;
  }
  next();
};

const uploadDocs = multer({ dest: ensureDocumentStoragePath() });

const router = Router();

router.use(authenticateToken);
router.use(requireProductionOrAdmin);

router.get("/health", healthPlanning);

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
