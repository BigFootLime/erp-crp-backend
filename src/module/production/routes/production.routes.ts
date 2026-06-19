import { Router, type RequestHandler } from "express";

import { upload } from "../../../middlewares/upload";
import { authenticateToken } from "../../auth/middlewares/auth.middleware";
import { HttpError } from "../../../utils/httpError";
import {
  archiveMachine,
  archivePoste,
  createMachine,
  createMachineOnboarding,
  createOfReceipt,
  createOrdreFabrication,
  createPoste,
  getOfReceiptContext,
  getOfTraceability,
  getOrdreFabrication,
  getMachine,
  getPoste,
  listOrdresFabrication,
  listMachines,
  listPostes,
  startOfOperationTimeLog,
  stopOfOperationTimeLog,
  updateOrdreFabrication,
  updateOrdreFabricationOperation,
  updateMachine,
  updateMachineOnboarding,
  updatePoste,
} from "../controllers/production.controller";
import {
  createProductionGroup,
  getProductionGroup,
  linkProductionGroup,
  listProductionGroups,
  unlinkProductionGroup,
  updateProductionGroup,
} from "../controllers/production-groups.controller";
import {
  createPointageManual,
  getPointage,
  listOperators,
  listPointages,
  patchPointage,
  pointagesKpis,
  startPointage,
  stopPointage,
  validatePointage,
} from "../controllers/pointages.controller";
import {
  getMachineModel,
  listMachineCapabilities,
  listMachineDocuments,
  listMachineModelCapabilities,
  listMachineModelDocuments,
  listMachineModels,
} from "../controllers/machine-intelligence.controller";

function isAdminRole(role: string | undefined): boolean {
  if (!role) return false;
  const r = role.trim().toLowerCase();
  return r.includes("admin") || r.includes("administrateur");
}

function isProductionRole(role: string | undefined): boolean {
  if (!role) return false;
  const r = role.trim().toLowerCase();
  return r.includes("production") || r.includes("atelier") || r.includes("secretaire") || r.includes("secretariat");
}

const requireAdmin: RequestHandler = (req, _res, next) => {
  if (!isAdminRole(req.user?.role)) {
    next(new HttpError(403, "FORBIDDEN", "Admin role required"));
    return;
  }
  next();
};

const requireProductionOrAdmin: RequestHandler = (req, _res, next) => {
  const role = req.user?.role;
  if (!isAdminRole(role) && !isProductionRole(role)) {
    next(new HttpError(403, "FORBIDDEN", "Production, atelier, secretariat or admin role required"));
    return;
  }
  next();
};

const router = Router();

router.use(authenticateToken);

// Machines
router.get("/machine-models", listMachineModels);
router.get("/machine-models/:id", getMachineModel);
router.get("/machine-models/:id/capabilities", listMachineModelCapabilities);
router.get("/machine-models/:id/documents", listMachineModelDocuments);

router.get("/machines", listMachines);
router.get("/machines/:id/capabilities", listMachineCapabilities);
router.get("/machines/:id/documents", listMachineDocuments);
router.get("/machines/:id", getMachine);
router.post("/machines/onboarding", requireProductionOrAdmin, upload.single("image"), createMachineOnboarding);
router.post("/machines", upload.single("image"), createMachine);
router.patch("/machines/:id/onboarding", requireProductionOrAdmin, upload.single("image"), updateMachineOnboarding);
router.patch("/machines/:id", upload.single("image"), updateMachine);
router.delete("/machines/:id", requireAdmin, archiveMachine);

// Postes
router.get("/postes", listPostes);
router.get("/postes/:id", getPoste);
router.post("/postes", createPoste);
router.patch("/postes/:id", updatePoste);
router.delete("/postes/:id", requireAdmin, archivePoste);

// OF
router.get("/ofs", listOrdresFabrication);
router.get("/ofs/:id", getOrdreFabrication);
router.post("/ofs", createOrdreFabrication);
router.patch("/ofs/:id", updateOrdreFabrication);
router.patch("/ofs/:id/operations/:opId", updateOrdreFabricationOperation);
router.post("/ofs/:id/operations/:opId/time-logs/start", startOfOperationTimeLog);
router.post("/ofs/:id/operations/:opId/time-logs/stop", stopOfOperationTimeLog);

// Phase 5 - Fin de production -> Entree en stock
router.get("/ofs/:id/receipt-context", getOfReceiptContext);
router.post("/ofs/:id/receipt", createOfReceipt);
router.get("/ofs/:id/traceability", getOfTraceability);

// Production Groups
router.get("/groups", requireProductionOrAdmin, listProductionGroups);
router.post("/groups", requireProductionOrAdmin, createProductionGroup);
router.get("/groups/:id", requireProductionOrAdmin, getProductionGroup);
router.patch("/groups/:id", requireProductionOrAdmin, updateProductionGroup);
router.post("/groups/:id/link", requireProductionOrAdmin, linkProductionGroup);
router.post("/groups/:id/unlink", requireProductionOrAdmin, unlinkProductionGroup);

// Pointages
router.get("/operators", requireProductionOrAdmin, listOperators);
router.get("/pointages", requireProductionOrAdmin, listPointages);
router.get("/pointages/kpis", requireProductionOrAdmin, pointagesKpis);
router.get("/pointages/:id", requireProductionOrAdmin, getPointage);
router.post("/pointages", requireProductionOrAdmin, createPointageManual);
router.post("/pointages/:id/start", requireProductionOrAdmin, startPointage);
router.post("/pointages/:id/stop", requireProductionOrAdmin, stopPointage);
router.patch("/pointages/:id", requireProductionOrAdmin, patchPointage);
router.post("/pointages/:id/validate", requireProductionOrAdmin, validatePointage);

export default router;
