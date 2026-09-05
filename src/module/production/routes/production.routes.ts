import {productionWorkbenchConfig} from '../controllers/production-workbench.controller';
import { Router, type RequestHandler } from "express";
import {synchronizePreparationChildren} from '../controllers/production-workbench.controller';
import {reusePreparationStock} from '../controllers/production-workbench.controller';
import {saveProgrammingTask,importPreparationPurchases} from '../controllers/production-workbench.controller';
import { previewConsolidation,createConsolidation,getConsolidation,dissolveConsolidation } from '../controllers/production-workbench.controller';
import { productionWorklist,preparationWorkbench,savePreparationDecisions,selectPreparationVersion,reviewPreparationStock,generateSelfInspection,downloadSelfInspection } from '../controllers/production-workbench.controller';

import {
  hasGrantedAccountModuleAccess,
  requestHasGrantedAccountModuleAccess,
} from "../../access-control/context/account-module-access.context";
import { createSecureUpload } from "../../../shared/uploads/secure-upload";
import { authenticateToken } from "../../auth/middlewares/auth.middleware";
import { HttpError } from "../../../utils/httpError";
import { roleHasMachineCapability, type MachineCapability } from "../domain/machine-rbac";
import { roleHasOfCapability, type OfCapability } from "../domain/of-rbac";
import {
  archiveMachine,
  archivePoste,
  createMachine,
  createMachineOnboarding,
  createOfReceipt,
  createOrdreFabrication,
  createPoste,
  downloadOfCreationSnapshot,
  generateOfs,
  getOfReceiptContext,
  getOfCreationSnapshot,
  getOfTechnicalSnapshot,
  getOfTechnicalPreparation,
  patchOfTechnicalPreparation,
  submitOfTechnicalPreparation,
  validateOfTechnicalPreparation,
  getOfTraceability,
  getOrdreFabrication,
  getOrdreFabricationTree,
  getMachine,
  getPoste,
  listOrdresFabrication,
  listMachines,
  listPostes,
  previewOfGeneration,
  previewOfCreationSnapshot,
  printOfCreationSnapshot,
  reorderOfOperations,
  startOfOperationTimeLog,
  stopOfOperationTimeLog,
  updateOrdreFabrication,
  getOfReadiness,
  releaseOrdreFabrication,
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
import {
  archiveMachineUnavailability,
  createMachineMaintenanceEvent,
  createMachineMaintenancePlan,
  createMachineDocument,
  createMachineUnavailability,
  downloadMachineDocument,
  getMachineParkContext,
  listMachineMaintenanceEvents,
  listMachineMaintenancePlans,
  listMachineUnavailability,
  reactivateMachine,
  removeMachineDocument,
  uploadMachineDocument,
  updateMachineMaintenancePlan,
} from "../controllers/machine-park.controller";

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
  if (
    requestHasGrantedAccountModuleAccess(req) ||
    hasGrantedAccountModuleAccess()
  ) {
    next();
    return;
  }
  if (!isAdminRole(req.user?.role)) {
    next(new HttpError(403, "FORBIDDEN", "Admin role required"));
    return;
  }
  next();
};

const requireProductionOrAdmin: RequestHandler = (req, _res, next) => {
  if (
    requestHasGrantedAccountModuleAccess(req) ||
    hasGrantedAccountModuleAccess()
  ) {
    next();
    return;
  }
  const role = req.user?.role;
  if (!isAdminRole(role) && !isProductionRole(role)) {
    next(new HttpError(403, "FORBIDDEN", "Production, atelier, secretariat or admin role required"));
    return;
  }
  next();
};

const requireMachineCapability = (capability: MachineCapability): RequestHandler => (req, _res, next) => {
  if (
    !requestHasGrantedAccountModuleAccess(req) &&
    !roleHasMachineCapability(req.user?.role, capability)
  ) {
    next(new HttpError(403, "MACHINE_FORBIDDEN", `Machine capability required: ${capability}`));
    return;
  }
  next();
};

// #170 : refus par défaut sur les mutations OF — chaque écriture exige une
// capacité explicite (la granularité fine transition/édition se rejoue au
// repository qui connaît le statut courant).
const requireOfCapability = (capability: OfCapability): RequestHandler => (req, _res, next) => {
  if (
    !requestHasGrantedAccountModuleAccess(req) &&
    !roleHasOfCapability(req.user?.role, capability)
  ) {
    next(new HttpError(403, "OF_FORBIDDEN", `OF capability required: ${capability}`));
    return;
  }
  next();
};

const requireAnyOfCapability = (capabilities: readonly OfCapability[]): RequestHandler => (req, _res, next) => {
  if (requestHasGrantedAccountModuleAccess(req)) {
    next();
    return;
  }
  if (!capabilities.some((capability) => roleHasOfCapability(req.user?.role, capability))) {
    next(new HttpError(403, "OF_FORBIDDEN", `OF capability required: ${capabilities.join("|")}`));
    return;
  }
  next();
};

const router = Router();
const machineDocumentUpload = createSecureUpload("machine-document", { maxFiles: 1 });
const machineImageUpload = createSecureUpload("image", { maxFiles: 1 });

router.use(authenticateToken);

// Machines
router.get("/machine-models", requireMachineCapability("read"), listMachineModels);
router.get("/machine-models/:id", requireMachineCapability("read"), getMachineModel);
router.get("/machine-models/:id/capabilities", requireMachineCapability("read"), listMachineModelCapabilities);
router.get("/machine-models/:id/documents", requireMachineCapability("read"), listMachineModelDocuments);

router.get("/machines", requireMachineCapability("read"), listMachines);
router.get("/machines/:id/context", requireMachineCapability("read"), getMachineParkContext);
router.get("/machines/:id/unavailability", requireMachineCapability("read"), listMachineUnavailability);
router.post("/machines/:id/unavailability", requireMachineCapability("availability"), createMachineUnavailability);
router.delete("/machines/:id/unavailability/:unavailabilityId", requireMachineCapability("availability"), archiveMachineUnavailability);
router.get("/machines/:id/maintenance/plans", requireMachineCapability("read"), listMachineMaintenancePlans);
router.post("/machines/:id/maintenance/plans", requireMachineCapability("maintenance"), createMachineMaintenancePlan);
router.patch("/machines/:id/maintenance/plans/:planId", requireMachineCapability("maintenance"), updateMachineMaintenancePlan);
router.get("/machines/:id/maintenance/events", requireMachineCapability("read"), listMachineMaintenanceEvents);
router.post("/machines/:id/maintenance/events", requireMachineCapability("maintenance"), createMachineMaintenanceEvent);
router.post("/machines/:id/reactivate", requireMachineCapability("restore"), reactivateMachine);
router.get("/machines/:id/capabilities", requireMachineCapability("read"), listMachineCapabilities);
router.get("/machines/:id/documents", requireMachineCapability("read"), listMachineDocuments);
router.post("/machines/:id/documents/upload", requireMachineCapability("documents"), machineDocumentUpload.single("document"), uploadMachineDocument);
router.post("/machines/:id/documents", requireMachineCapability("documents"), createMachineDocument);
router.get("/machines/:id/documents/:documentId/download", requireMachineCapability("read"), downloadMachineDocument);
router.delete("/machines/:id/documents/:documentId", requireMachineCapability("documents"), removeMachineDocument);
router.get("/machines/:id", requireMachineCapability("read"), getMachine);
router.post("/machines/onboarding", requireMachineCapability("create"), machineImageUpload.single("image"), createMachineOnboarding);
router.post("/machines", requireMachineCapability("create"), machineImageUpload.single("image"), createMachine);
router.patch("/machines/:id/onboarding", requireMachineCapability("update"), machineImageUpload.single("image"), updateMachineOnboarding);
router.patch("/machines/:id", requireMachineCapability("update"), machineImageUpload.single("image"), updateMachine);
router.delete("/machines/:id", requireMachineCapability("archive"), archiveMachine);

// Postes
router.get("/postes", listPostes);
router.get("/postes/:id", getPoste);
router.post("/postes", createPoste);
router.patch("/postes/:id", updatePoste);
router.delete("/postes/:id", requireAdmin, archivePoste);

// OF — lectures au JWT (consommées par planning/commandes/affaires),
// mutations sous capacités #170 (refus par défaut).
router.get("/ofs", listOrdresFabrication);
router.get('/workbench/config',requireOfCapability('read'),productionWorkbenchConfig);
router.get('/worklist',requireOfCapability('read'),productionWorklist);
router.post('/consolidations/preview',requireOfCapability('generate'),previewConsolidation);
router.post('/consolidations',requireOfCapability('generate'),createConsolidation);
router.get('/consolidations/:id',requireOfCapability('read'),getConsolidation);
router.post('/consolidations/:id/dissolve',requireOfCapability('cancel'),dissolveConsolidation);
router.get('/ofs/:id/workbench',requireOfCapability('read'),preparationWorkbench);
router.post('/ofs/:id/workbench/children/synchronize',requireOfCapability('generate'),synchronizePreparationChildren);
router.post('/ofs/:id/workbench/programming',requireOfCapability('revise'),saveProgrammingTask);
router.post('/ofs/:id/workbench/purchases/import',requireOfCapability('edit_prelaunch'),importPreparationPurchases);
router.patch('/ofs/:id/workbench/decisions',requireOfCapability('edit_prelaunch'),savePreparationDecisions);
router.post('/ofs/:id/workbench/version',requireOfCapability('edit_prelaunch'),selectPreparationVersion);
router.post('/ofs/:id/workbench/stock-review',requireOfCapability('edit_prelaunch'),reviewPreparationStock);
router.post('/ofs/:id/workbench/stock-reuse',requireOfCapability('quality_decision'),reusePreparationStock);
router.post('/ofs/:id/workbench/self-inspection',requireOfCapability('edit_prelaunch'),generateSelfInspection);
router.get('/ofs/:id/workbench/self-inspection/:sheetId',requireOfCapability('read'),downloadSelfInspection);
router.post("/ofs/generate/preview", requireOfCapability("generate"), previewOfGeneration);
router.post("/ofs/generate", requireOfCapability("generate"), generateOfs);
router.get("/ofs/:id/tree", getOrdreFabricationTree);
router.get("/ofs/:id/technical-snapshot", getOfTechnicalSnapshot);
router.get("/ofs/:id/technical-preparation", requireOfCapability("read"), getOfTechnicalPreparation);
router.patch("/ofs/:id/technical-preparation", requireOfCapability("edit_prelaunch"), patchOfTechnicalPreparation);
router.post("/ofs/:id/technical-preparation/submit", requireOfCapability("edit_prelaunch"), submitOfTechnicalPreparation);
router.post("/ofs/:id/technical-preparation/validate", requireOfCapability("release"), validateOfTechnicalPreparation);
// Internal creation snapshot, filed automatically on root creation. Same read
// middleware as the OF card; no route can issue or reissue it.
router.get("/ofs/:id/creation-snapshot", getOfCreationSnapshot);
router.get("/ofs/:id/creation-snapshot/:documentId/preview", previewOfCreationSnapshot);
router.get("/ofs/:id/creation-snapshot/:documentId/download", downloadOfCreationSnapshot);
router.post("/ofs/:id/creation-snapshot/:documentId/print-intents", printOfCreationSnapshot);
router.get("/ofs/:id", getOrdreFabrication);
router.get("/ofs/:id/readiness", requireOfCapability("read"), getOfReadiness);
router.post("/ofs/:id/release", requireOfCapability("release"), releaseOrdreFabrication);
router.post("/ofs", requireOfCapability("create"), createOrdreFabrication);
router.patch("/ofs/:id", requireAnyOfCapability(["edit_prelaunch", "launch", "operate", "cancel", "archive"]), updateOrdreFabrication);
router.patch("/ofs/:id/operations/reorder", requireOfCapability("edit_prelaunch"), reorderOfOperations);
router.patch("/ofs/:id/operations/:opId", requireAnyOfCapability(["operate", "edit_prelaunch"]), updateOrdreFabricationOperation);
router.post("/ofs/:id/operations/:opId/time-logs/start", requireOfCapability("operate"), startOfOperationTimeLog);
router.post("/ofs/:id/operations/:opId/time-logs/stop", requireOfCapability("operate"), stopOfOperationTimeLog);

// Phase 5 - Fin de production -> Entree en stock
router.get("/ofs/:id/receipt-context", requireOfCapability("receipt"), getOfReceiptContext);
router.post("/ofs/:id/receipt", requireOfCapability("receipt"), createOfReceipt);
router.get("/ofs/:id/traceability", requireOfCapability("traceability"), getOfTraceability);

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
