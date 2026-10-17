import { Router, type RequestHandler } from "express";
import { HttpError } from "../../../utils/httpError";
import { requestHasGrantedAccountModuleAccess } from "../../access-control/context/account-module-access.context";
import { listComptesVente, listConditionsPaiement } from "../controllers/commercial-references.controller";

const router = Router();

// The two historic URLs are read-only options shared by Clients and Devis. The
// global gate records the module that actually granted access; never accept an
// unrelated module context here when these routes are mounted in another app.
const requireCommercialReferenceRead: RequestHandler = (req, _res, next) => {
  const grantedModule = req.accountModuleAccess?.moduleKey;
  if (requestHasGrantedAccountModuleAccess(req) && (grantedModule === "clients" || grantedModule === "devis")) {
    next();
    return;
  }
  next(new HttpError(403, "FORBIDDEN", "Accès interdit."));
};

router.get("/conditions-paiement", requireCommercialReferenceRead, listConditionsPaiement);
router.get("/compte-vente", requireCommercialReferenceRead, listComptesVente);

export default router;
