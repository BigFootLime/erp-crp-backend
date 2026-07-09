import { Router } from "express";
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

export default router;
