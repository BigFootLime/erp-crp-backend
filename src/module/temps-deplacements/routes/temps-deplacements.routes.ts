import { Router } from "express";
import * as cor from "../controllers/temps-deplacements-corrections.controller";
import * as c from "../controllers/temps-deplacements.controller";

// Monté après le socle authenticateToken (v1.routes.ts) → JWT requis d'office.
// Anti-IDOR : les routes salarié dérivent l'employé de req.user ; /employees/:id/* est gardé
// (soi-même / manager / RH-Direction-Admin). Device : JWT + device_token haché.
const router = Router();

// Salarié (self-service)
router.post("/events", c.postEvent);
router.get("/me/today", c.getMeToday);
router.get("/me/week", c.getMeWeek);
router.get("/me/anomalies", c.getMeAnomalies);

// Lecture périmètre (manager / RH) + anti-IDOR
router.get("/employees/:id/today", c.getEmployeeToday);
router.get("/employees/:id/week", c.getEmployeeWeek);

// Borne / device
router.get("/device-config", c.getDeviceConfig);
router.post("/device-events", c.postDeviceEvent);
router.post("/device-heartbeat", c.postDeviceHeartbeat);

// T4 — corrections tracées (motif obligatoire, pas d'auto-validation) + validation responsable
router.post("/adjustments", cor.postAdjustment); // salarié : demande sur ses données
router.patch("/adjustments/:id/approve", cor.approveAdjustment); // responsable/RH
router.patch("/adjustments/:id/reject", cor.rejectAdjustment); // responsable/RH
router.get("/team/adjustments", cor.getTeamAdjustments); // demandes en attente (périmètre)
router.get("/team/today", cor.getTeamToday); // relevé du jour de l'équipe
router.get("/team/anomalies", cor.getTeamAnomalies); // anomalies équipe du jour
router.patch("/days/:id/validate", cor.validateDay); // valide une journée
router.patch("/weeks/:id/validate", cor.validateWeek); // valide une semaine

export default router;
