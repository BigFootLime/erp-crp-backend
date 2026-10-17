import { Router } from "express";
import * as adm from "../controllers/temps-deplacements-admin.controller";
import * as cor from "../controllers/temps-deplacements-corrections.controller";
import * as dev from "../controllers/temps-deplacements-devices.controller";
import * as exp from "../controllers/temps-deplacements-exports.controller";
import * as km from "../controllers/temps-deplacements-km.controller";
import * as c from "../controllers/temps-deplacements.controller";
import * as ops from "../controllers/temps-deplacements-operations.controller";
import { requireHrSensitiveRead, requireHrSensitiveWrite } from "../middlewares/hr-sensitive-authorization.middleware";

// Monté après le socle authenticateToken (v1.routes.ts) → JWT requis d'office.
// Anti-IDOR : les routes salarié dérivent l'employé de req.user ; /employees/:id/* conserve
// le self-service et exige une habilitation RH pour un tiers. Les deux commandes de borne autonomes
// sont isolées dans temps-deplacements-device.routes.ts avant ce socle.
const router = Router();

// Salarié (self-service)
router.post("/events", c.postEvent);
router.get("/me/today", c.getMeToday);
router.get("/me/week", c.getMeWeek);
router.get("/me/anomalies", c.getMeAnomalies);
router.get("/permissions", c.getPermissions);

// Lecture d'un tiers avec habilitation RH nominative + anti-IDOR.
router.get("/employees/:id/today", c.getEmployeeToday);
router.get("/employees/:id/week", c.getEmployeeWeek);

// Borne / device
router.get("/device-config", c.getDeviceConfig);

// T4 — corrections tracées (motif obligatoire, pas d'auto-validation).
router.post("/adjustments", cor.postAdjustment); // salarié : demande sur ses données
router.patch("/adjustments/:id/approve", requireHrSensitiveWrite, cor.approveAdjustment);
router.patch("/adjustments/:id/reject", requireHrSensitiveWrite, cor.rejectAdjustment);
router.get("/team/adjustments", requireHrSensitiveRead, cor.getTeamAdjustments);
router.get("/team/today", requireHrSensitiveRead, cor.getTeamToday);
router.get("/team/anomalies", requireHrSensitiveRead, cor.getTeamAnomalies);
router.patch("/days/:id/validate", requireHrSensitiveWrite, cor.validateDay);
router.patch("/weeks/:id/validate", requireHrSensitiveWrite, cor.validateWeek);

// SOL-24 — absences explicites et file d'actions responsable.
router.post("/absences", ops.postAbsence);
router.get("/absences/me", ops.getMyAbsences);
router.get("/team/absences", requireHrSensitiveRead, ops.getTeamAbsences);
router.patch("/absences/:id/approve", requireHrSensitiveWrite, ops.approveAbsence);
router.patch("/absences/:id/reject", requireHrSensitiveWrite, ops.rejectAbsence);
router.get("/team/operations-queue", requireHrSensitiveRead, ops.getOperationsQueue);

// T5 — administration RH (règles / contrats / horaires), habilitation sensible obligatoire.
router.get("/admin/employees", requireHrSensitiveRead, adm.getEmployees);
router.get("/admin/employee-candidates", requireHrSensitiveRead, adm.getEmployeeCandidates);
router.post("/admin/employees", requireHrSensitiveWrite, adm.postEmployee);
router.get("/admin/rule-sets", requireHrSensitiveRead, adm.getRuleSets);
router.post("/admin/rule-sets", requireHrSensitiveWrite, adm.postRuleSet);
router.put("/admin/rule-sets/:id", requireHrSensitiveWrite, adm.putRuleSet);
router.patch("/admin/rule-sets/:id/active", requireHrSensitiveWrite, adm.patchRuleSetActive);
router.get("/admin/contracts", requireHrSensitiveRead, adm.getContracts);
router.post("/admin/contracts", requireHrSensitiveWrite, adm.postContract);
router.put("/admin/contracts/:id", requireHrSensitiveWrite, adm.putContract);
router.patch("/admin/contracts/:id/active", requireHrSensitiveWrite, adm.patchContractActive);
router.get("/admin/schedules", requireHrSensitiveRead, adm.getSchedules);
router.post("/admin/schedules", requireHrSensitiveWrite, adm.postSchedule);
router.put("/admin/schedules/:id", requireHrSensitiveWrite, adm.putSchedule);
router.delete("/admin/schedules/:id", requireHrSensitiveWrite, adm.deleteScheduleHandler);

// T7 — exports paie figés (CSV `;`+BOM / PDF) + checksum.
router.get("/admin/exports", requireHrSensitiveRead, exp.getExports);
router.post("/admin/exports", requireHrSensitiveWrite, exp.postExport);
router.get("/admin/exports/:id/download", requireHrSensitiveRead, exp.downloadExport);

// T6 — kilomètres. Salarié : déclare/soumet SES km (anti-IDOR); décisions sensibles dédiées.
router.get("/kilometers/vehicles", km.getVehicles);
router.post("/kilometers", km.postKm);
router.get("/kilometers/me", km.getMyKm);
router.patch("/kilometers/:id/submit", km.submitKm);
router.get("/kilometers/team", requireHrSensitiveRead, km.getTeamKm);
router.patch("/kilometers/:id/validate", requireHrSensitiveWrite, km.validateKm);
router.patch("/kilometers/:id/reject", requireHrSensitiveWrite, km.rejectKm);
router.post("/admin/vehicles", requireHrSensitiveWrite, km.postVehicle);
router.get("/admin/period-closures", requireHrSensitiveRead, ops.getClosures);
router.post("/admin/period-closures", requireHrSensitiveWrite, ops.postClosure);
router.patch("/admin/period-closures/:id/reopen", requireHrSensitiveWrite, ops.reopenClosure);
router.get("/admin/kilometer-rates", requireHrSensitiveRead, ops.getKilometerRates);
router.post("/admin/kilometer-rates", requireHrSensitiveWrite, ops.postKilometerRate);

// T8 — bornes & badges (provisioning), habilitation sensible obligatoire. Token borne renvoyé 1× à la création.
router.get("/admin/devices", requireHrSensitiveRead, dev.getDevices);
router.post("/admin/devices", requireHrSensitiveWrite, dev.postDevice);
router.patch("/admin/devices/:id/status", requireHrSensitiveWrite, dev.patchDeviceStatus);
router.post("/admin/devices/:id/rotate-token", requireHrSensitiveWrite, dev.postDeviceRotate);
router.get("/admin/badges", requireHrSensitiveRead, dev.getBadges);
router.post("/admin/badges", requireHrSensitiveWrite, dev.postBadge);
router.patch("/admin/badges/:id/revoke", requireHrSensitiveWrite, dev.revokeBadgeHandler);

export default router;
