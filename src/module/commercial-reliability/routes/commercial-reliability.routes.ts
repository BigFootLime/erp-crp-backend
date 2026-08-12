import type { RequestHandler } from "express";
import { Router } from "express";

import { HttpError } from "../../../utils/httpError";
import { effectiveRoleHasAny, hasAnyAssignedRole, normalizeAssignedRoles } from "../../auth/domain/roles";
import { requireFinanceCapability } from "../../facturation/middlewares/finance-authorization.middleware";
import {
  cancelOrder,
  commercialOrderTimeline,
  commercialOverview,
  decideDiscountApproval,
  expireDueQuotes,
  recordQuoteLoss,
  recordQuoteReminder,
  requestDiscountApproval,
} from "../controllers/commercial-reliability.controller";

const COMMERCIAL_ACTORS = [
  "Commercial",
  "Secretaire",
  "Directeur",
  "Administrateur Systeme et Reseau",
] as const;
const COMMERCIAL_DECIDERS = ["Directeur", "Administrateur Systeme et Reseau"] as const;

function requireAssignedRole(allowed: readonly string[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.user) {
      next(new HttpError(401, "UNAUTHORIZED", "Authentification requise."));
      return;
    }
    const primaryRole = req.user.primary_role ?? req.user.role;
    const assignedRoles = normalizeAssignedRoles(primaryRole, req.user.roles);
    if (!effectiveRoleHasAny(req.user.role, allowed) && !hasAnyAssignedRole(primaryRole, assignedRoles, allowed)) {
      next(new HttpError(403, "COMMERCIAL_CAPABILITY_REQUIRED", "Votre rôle ne permet pas cette action commerciale."));
      return;
    }
    next();
  };
}

const router = Router();

router.get("/overview", requireFinanceCapability("reporting_financial"), commercialOverview);
router.get("/orders/:id/timeline", requireFinanceCapability("reporting_read"), commercialOrderTimeline);
router.post("/quotes/:id/reminders", requireAssignedRole(COMMERCIAL_ACTORS), recordQuoteReminder);
router.post("/quotes/:id/loss", requireAssignedRole(COMMERCIAL_ACTORS), recordQuoteLoss);
router.post("/quotes/:id/discount-approvals", requireAssignedRole(COMMERCIAL_ACTORS), requestDiscountApproval);
router.post("/quotes/:id/discount-decisions", requireAssignedRole(COMMERCIAL_DECIDERS), decideDiscountApproval);
router.post("/quotes/expire-due", requireAssignedRole(COMMERCIAL_DECIDERS), expireDueQuotes);
router.post("/orders/:id/cancel", requireAssignedRole(COMMERCIAL_DECIDERS), cancelOrder);

export default router;
