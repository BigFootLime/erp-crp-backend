import { Router, type RequestHandler } from "express";
import fs from "node:fs";
import multer from "multer";
import path from "node:path";

import { authenticateToken } from "../../auth/middlewares/auth.middleware";
import { HttpError } from "../../../utils/httpError";

import {
  attachActionDocuments,
  attachControlDocuments,
  attachNonConformityDocuments,
  createAction,
  createControl,
  createNonConformity,
  downloadActionDocument,
  downloadControlDocument,
  downloadNonConformityDocument,
  getAction,
  getControl,
  getNonConformity,
  listActionDocuments,
  listActions,
  listControlDocuments,
  listControls,
  listNonConformities,
  listNonConformityDocuments,
  listQualityUsers,
  patchAction,
  patchControl,
  patchNonConformity,
  qualiteKpis,
  removeActionDocument,
  removeControlDocument,
  removeNonConformityDocument,
  validateControl,
} from "../controllers/qualite.controller";

function isAdminRole(role: string | undefined): boolean {
  if (!role) return false;
  const r = role.trim().toLowerCase();
  return r.includes("admin") || r.includes("administrateur");
}

function isQualityRole(role: string | undefined): boolean {
  if (!role) return false;
  const r = role.trim().toLowerCase();
  return r.includes("qualit") || r.includes("quality") || r.includes("qse");
}

const requireQualityOrAdmin: RequestHandler = (req, _res, next) => {
  const role = req.user?.role;
  if (!isAdminRole(role) && !isQualityRole(role)) {
    next(new HttpError(403, "FORBIDDEN", "Quality role required"));
    return;
  }
  next();
};

const router = Router();
router.use(authenticateToken);
router.use(requireQualityOrAdmin);

// KPIs + users for selects
router.get("/kpis", qualiteKpis);
router.get("/users", listQualityUsers);

// Controls
router.get("/controls", listControls);
router.get("/controls/:id", getControl);
router.post("/controls", createControl);
router.patch("/controls/:id", patchControl);
router.post("/controls/:id/validate", validateControl);

// Non-conformities
router.get("/non-conformities", listNonConformities);
router.get("/non-conformities/:id", getNonConformity);
router.post("/non-conformities", createNonConformity);
router.patch("/non-conformities/:id", patchNonConformity);

// Actions
router.get("/actions", listActions);
router.get("/actions/:id", getAction);
router.post("/actions", createAction);
router.patch("/actions/:id", patchAction);

// Documents (multer)
const ensureDir = (dir: string) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
};

const docsBaseDir = path.resolve("uploads/docs/qualite");
ensureDir(docsBaseDir);

const upload = multer({
  dest: docsBaseDir,
  limits: {
    fileSize: 25 * 1024 * 1024,
  },
});

router.get("/controls/:id/documents", listControlDocuments);
router.post("/controls/:id/documents", upload.array("documents[]"), attachControlDocuments);
router.delete("/controls/:id/documents/:docId", removeControlDocument);
router.get("/controls/:id/documents/:docId/file", downloadControlDocument);

router.get("/non-conformities/:id/documents", listNonConformityDocuments);
router.post("/non-conformities/:id/documents", upload.array("documents[]"), attachNonConformityDocuments);
router.delete("/non-conformities/:id/documents/:docId", removeNonConformityDocument);
router.get("/non-conformities/:id/documents/:docId/file", downloadNonConformityDocument);

router.get("/actions/:id/documents", listActionDocuments);
router.post("/actions/:id/documents", upload.array("documents[]"), attachActionDocuments);
router.delete("/actions/:id/documents/:docId", removeActionDocument);
router.get("/actions/:id/documents/:docId/file", downloadActionDocument);

export default router;
