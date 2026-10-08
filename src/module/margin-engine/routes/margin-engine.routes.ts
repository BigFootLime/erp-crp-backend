import { Router, type RequestHandler } from "express";
import { requestHasGrantedAccountModuleAccess } from "../../access-control/context/account-module-access.context";
import { HttpError } from "../../../utils/httpError";
import { canUseMarginCapability, type MarginCapability } from "../domain/margin-engine-policy";
import {
  createMarginInput,
  createMarginSnapshot,
  createRateVersion,
  exportMargin,
  getMargin,
  listRateVersions,
  listMarginSnapshots,
  declareManufacturingBasis,
  getManufacturingBasis,
  getManufacturingBasisCandidate,
  readOpeningValueCandidate,
  readOpeningValueBasis,
  declareOpeningValueBasis,
} from "../controllers/margin-engine.controller";

import { readValueAdjustmentCandidate,listValueAdjustments,declareValueAdjustment } from '../../stock/controllers/cump-value-adjustment.controller';

const router = Router();

function requireMarginCapability(capability: MarginCapability): RequestHandler {
  return (req, _res, next) => {
    if (canUseMarginCapability(req.user?.role, capability, requestHasGrantedAccountModuleAccess(req))) {
      next();
      return;
    }
    next(new HttpError(403, "FORBIDDEN", `Capacité de marge « ${capability} » requise.`));
  };
}

router.get("/rate-versions", requireMarginCapability("read_costs"), listRateVersions);
router.post("/rate-versions", requireMarginCapability("manage_rates"), createRateVersion);
router.post("/inputs", requireMarginCapability("manage_inputs"), createMarginInput);
router.get('/of/:ofId/manufacturing-basis/candidates/:snapshotId', requireMarginCapability('read_costs'), getManufacturingBasisCandidate);
router.get('/of/:ofId/manufacturing-basis', requireMarginCapability('read_costs'), getManufacturingBasis);
router.post('/of/:ofId/manufacturing-basis', requireMarginCapability('snapshot'), declareManufacturingBasis);
router.get('/stock-opening/:articleId/:unit/candidate',requireMarginCapability('read_costs'),readOpeningValueCandidate);
router.get('/stock-opening/:articleId/:unit/basis',requireMarginCapability('read_costs'),readOpeningValueBasis);
router.post('/stock-opening/:articleId/:unit/basis',requireMarginCapability('snapshot'),declareOpeningValueBasis);
router.get('/stock-value/:articleId/:unit/candidate',requireMarginCapability('read_costs'),readValueAdjustmentCandidate);
router.get('/stock-value/:articleId/:unit/adjustments',requireMarginCapability('read_costs'),listValueAdjustments);
router.post('/stock-value/:articleId/:unit/adjustments',requireMarginCapability('snapshot'),declareValueAdjustment);
router.get("/:scopeType/:scopeRef/export.csv", requireMarginCapability("export"), exportMargin);
router.get("/:scopeType/:scopeRef/snapshots", requireMarginCapability("read_costs"), listMarginSnapshots);
router.post("/:scopeType/:scopeRef/snapshots", requireMarginCapability("snapshot"), createMarginSnapshot);
router.get("/:scopeType/:scopeRef", requireMarginCapability("read_costs"), getMargin);

export default router;
