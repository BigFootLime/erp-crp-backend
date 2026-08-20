import { Router, type RequestHandler } from "express";
import { HttpError } from "../../../utils/httpError";
import { requestHasGrantedAccountModuleAccess } from "../../access-control/context/account-module-access.context";
import { roleHasDevisCapability } from "../../devis/domain/devis-rbac";
import { listComptesVente, listConditionsPaiement } from "../controllers/commercial-references.controller";

const router = Router();

// These options are part of the quote-entry boundary. The legacy URLs are kept
// intentionally, but they have the same server-side read permission as Devis.
const requireDevisRead: RequestHandler = (req, _res, next) => {
  if (requestHasGrantedAccountModuleAccess(req) || roleHasDevisCapability(req.user?.role, "read")) {
    next();
    return;
  }
  next(new HttpError(403, "FORBIDDEN", "Votre rôle ne permet pas de consulter les référentiels de devis."));
};

router.get("/conditions-paiement", requireDevisRead, listConditionsPaiement);
router.get("/compte-vente", requireDevisRead, listComptesVente);

export default router;
