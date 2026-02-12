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

function isAdminRole(role: string | undefined): boolean {
  if (!role) return false;
  const r = role.trim().toLowerCase();
  return r.includes("admin") || r.includes("administrateur");
}

const requireAdmin: RequestHandler = (req, _res, next) => {
  if (!isAdminRole(req.user?.role)) {
    next(new HttpError(403, "FORBIDDEN", "Admin role required"));
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

export default router;
