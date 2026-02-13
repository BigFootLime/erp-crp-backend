import { Router, type RequestHandler } from "express";

import { upload } from "../../../middlewares/upload";
import { authenticateToken } from "../../auth/middlewares/auth.middleware";
import { HttpError } from "../../../utils/httpError";
import {
  archiveMachine,
  archivePoste,
  createMachine,
  createOrdreFabrication,
  createPoste,
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
  updatePoste,
} from "../controllers/production.controller";
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
    next(new HttpError(403, "FORBIDDEN", "Production role required"));
    return;
  }
  next();
};

const router = Router();

router.use(authenticateToken);

// Machines
router.get("/machines", listMachines);
router.get("/machines/:id", getMachine);
router.post("/machines", upload.single("image"), createMachine);
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
