import { Router, type RequestHandler } from "express";
import multer from "multer";
import { authenticateToken } from "../../auth/middlewares/auth.middleware";
import { HttpError } from "../../../utils/httpError";
import {
  archivePlanningEvent,
  createPlanningEvent,
  createPlanningEventComment,
  getPlanningEvent,
  getPlanningEventDocumentFile,
  healthPlanning,
  listPlanningEvents,
  listPlanningResources,
  patchPlanningEvent,
  uploadPlanningEventDocuments,
} from "../controllers/planning.controller";

function isAdminRole(role: string | undefined): boolean {
  if (!role) return false;
  const r = role.trim().toLowerCase();
  return r.includes("admin") || r.includes("administrateur");
}

function isProductionRole(role: string | undefined): boolean {
  if (!role) return false;
  const r = role.trim().toLowerCase();
  return r.includes("production") || r.includes("atelier");
}

const requireProductionOrAdmin: RequestHandler = (req, _res, next) => {
  const role = req.user?.role;
  if (!isAdminRole(role) && !isProductionRole(role)) {
    next(new HttpError(403, "FORBIDDEN", "Production role required"));
    return;
  }
  next();
};

const uploadDocs = multer({ dest: "uploads/docs" });

const router = Router();

router.use(authenticateToken);
router.use(requireProductionOrAdmin);

router.get("/health", healthPlanning);

router.get("/resources", listPlanningResources);
router.get("/events", listPlanningEvents);
router.post("/events", createPlanningEvent);
router.get("/events/:id", getPlanningEvent);
router.patch("/events/:id", patchPlanningEvent);
router.delete("/events/:id", archivePlanningEvent);
router.post("/events/:id/comments", createPlanningEventComment);

router.post("/events/:id/documents", uploadDocs.array("documents[]"), uploadPlanningEventDocuments);
router.get("/events/:id/documents/:docId/file", getPlanningEventDocumentFile);

export default router;
