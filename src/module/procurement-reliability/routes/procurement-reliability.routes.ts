import { Router, type RequestHandler } from "express";

import { HttpError } from "../../../utils/httpError";
import { requestHasGrantedAccountModuleAccess } from "../../access-control/context/account-module-access.context";
import {
  roleHasCommandeFournisseurCapability,
  type CommandeFournisseurCapability,
} from "../../commande-fournisseur/domain/commande-fournisseur-rbac";
import {
  createProcurementPolicy,
  procurementOverview,
  reviseProcurementPromise,
  updateProcurementAnomalyAction,
} from "../controllers/procurement-reliability.controller";

function requireCapability(capability: CommandeFournisseurCapability): RequestHandler {
  return (req, _res, next) => {
    if (!requestHasGrantedAccountModuleAccess(req) && !roleHasCommandeFournisseurCapability(req.user?.role, capability)) {
      next(new HttpError(403, "PROCUREMENT_CAPABILITY_REQUIRED", "Votre rôle ne permet pas cette action de pilotage achats."));
      return;
    }
    next();
  };
}

function requireRoleCapability(capability: CommandeFournisseurCapability): RequestHandler {
  return (req, _res, next) => {
    if (!roleHasCommandeFournisseurCapability(req.user?.role, capability)) {
      next(new HttpError(403, "PROCUREMENT_ROLE_CAPABILITY_REQUIRED", "Cette décision de politique achats est réservée à la Direction ou à l'administration."));
      return;
    }
    next();
  };
}

const router = Router();

router.get("/overview", requireCapability("read"), procurementOverview);
router.put("/anomalies/:anomalyKey/action", requireCapability("close"), updateProcurementAnomalyAction);
router.post("/orders/:id/promised-dates", requireCapability("acknowledge"), reviseProcurementPromise);
router.post("/policies", requireRoleCapability("approve"), createProcurementPolicy);

export default router;
