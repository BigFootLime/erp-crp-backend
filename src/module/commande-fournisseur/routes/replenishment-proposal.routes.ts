import { Router, type RequestHandler } from "express"

import { requestHasGrantedAccountModuleAccess } from "../../access-control/context/account-module-access.context"
import { HttpError } from "../../../utils/httpError"
import { roleHasCommandeFournisseurCapability, type CommandeFournisseurCapability } from "../domain/commande-fournisseur-rbac"
import {
  listReplenishmentProposals,
  refreshReplenishmentProposals,
  validateReplenishmentProposal,
} from "../controllers/replenishment-proposal.controller"

function requireCapability(capability: CommandeFournisseurCapability): RequestHandler {
  return (req, _res, next) => {
    if (!requestHasGrantedAccountModuleAccess(req) && !roleHasCommandeFournisseurCapability(req.user?.role, capability)) {
      next(new HttpError(403, "FORBIDDEN", "Votre rôle ne permet pas cette action de réapprovisionnement."))
      return
    }
    next()
  }
}

const router = Router()
router.get("/", requireCapability("read"), requireCapability("prices"), listReplenishmentProposals)
router.post("/refresh", requireCapability("create"), requireCapability("prices"), refreshReplenishmentProposals)
router.post("/:id/validate", requireCapability("create"), requireCapability("prices"), validateReplenishmentProposal)

export default router
