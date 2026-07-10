import { Router } from "express";
import * as adm from "../controllers/temps-deplacements-admin.controller";
import * as cor from "../controllers/temps-deplacements-corrections.controller";
import * as dev from "../controllers/temps-deplacements-devices.controller";
import * as exp from "../controllers/temps-deplacements-exports.controller";
import * as km from "../controllers/temps-deplacements-km.controller";
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

// T5 — administration RH (règles / contrats / horaires). Réservé aux rôles privilégiés (service).
router.get("/admin/employees", adm.getEmployees);
router.get("/admin/rule-sets", adm.getRuleSets);
router.post("/admin/rule-sets", adm.postRuleSet);
router.put("/admin/rule-sets/:id", adm.putRuleSet);
router.patch("/admin/rule-sets/:id/active", adm.patchRuleSetActive);
router.get("/admin/contracts", adm.getContracts);
router.post("/admin/contracts", adm.postContract);
router.put("/admin/contracts/:id", adm.putContract);
router.patch("/admin/contracts/:id/active", adm.patchContractActive);
router.get("/admin/schedules", adm.getSchedules);
router.post("/admin/schedules", adm.postSchedule);
router.put("/admin/schedules/:id", adm.putSchedule);
router.delete("/admin/schedules/:id", adm.deleteScheduleHandler);

// T7 — exports paie figés (CSV `;`+BOM / PDF) + checksum. Réservé aux rôles privilégiés (service).
router.get("/admin/exports", exp.getExports);
router.post("/admin/exports", exp.postExport);
router.get("/admin/exports/:id/download", exp.downloadExport);

// T6 — kilomètres. Salarié : déclare/soumet SES km (anti-IDOR). Responsable : périmètre + validation.
router.get("/kilometers/vehicles", km.getVehicles);
router.post("/kilometers", km.postKm);
router.get("/kilometers/me", km.getMyKm);
router.patch("/kilometers/:id/submit", km.submitKm);
router.get("/kilometers/team", km.getTeamKm);
router.patch("/kilometers/:id/validate", km.validateKm);
router.patch("/kilometers/:id/reject", km.rejectKm);
router.post("/admin/vehicles", km.postVehicle);

// T8 — bornes & badges (provisioning). Réservé aux rôles privilégiés (service). Token borne renvoyé 1× à la création.
router.get("/admin/devices", dev.getDevices);
router.post("/admin/devices", dev.postDevice);
router.patch("/admin/devices/:id/status", dev.patchDeviceStatus);
router.post("/admin/devices/:id/rotate-token", dev.postDeviceRotate);
router.get("/admin/badges", dev.getBadges);
router.post("/admin/badges", dev.postBadge);
router.patch("/admin/badges/:id/revoke", dev.revokeBadgeHandler);

export default router;
