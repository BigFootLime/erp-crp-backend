import { Router, type RequestHandler } from "express";
import { requestHasGrantedAccountModuleAccess } from "../../access-control/context/account-module-access.context";
import { HttpError } from "../../../utils/httpError";
import { roleHasMarginCapability, type MarginCapability } from "../domain/margin-engine-policy";
import {
  createMarginInput,
  createMarginSnapshot,
  createRateVersion,
  exportMargin,
  getMargin,
  listRateVersions,
} from "../controllers/margin-engine.controller";

const router = Router();

function requireMarginCapability(capability: MarginCapability): RequestHandler {
  return (req, _res, next) => {
    if (requestHasGrantedAccountModuleAccess(req) || roleHasMarginCapability(req.user?.role, capability)) {
      next();
      return;
    }
    next(new HttpError(403, "FORBIDDEN", `Capacité de marge « ${capability} » requise.`));
  };
}

router.get("/rate-versions", requireMarginCapability("read_costs"), listRateVersions);
router.post("/rate-versions", requireMarginCapability("manage_rates"), createRateVersion);
router.post("/inputs", requireMarginCapability("manage_inputs"), createMarginInput);
router.get("/:scopeType/:scopeRef/export.csv", requireMarginCapability("export"), exportMargin);
router.post("/:scopeType/:scopeRef/snapshots", requireMarginCapability("snapshot"), createMarginSnapshot);
router.get("/:scopeType/:scopeRef", requireMarginCapability("read_costs"), getMargin);

export default router;
