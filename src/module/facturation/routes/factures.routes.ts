import { Router, type RequestHandler } from "express";
import { authenticateToken } from "../../auth/middlewares/auth.middleware";
import { HttpError } from "../../../utils/httpError";
import {
  createFacture,
  deleteFacture,
  generateFacturePdf,
  getFacture,
  getFacturePdf,
  listFactures,
  updateFacture,
} from "../controllers/factures.controller";

const router = Router();

function hasAnyRole(role: string | undefined, needles: string[]): boolean {
  if (!role) return false;
  const normalized = role.trim().toLowerCase();
  return needles.some((needle) => normalized.includes(needle));
}

const requireFacturationWrite: RequestHandler = (req, _res, next) => {
  if (hasAnyRole(req.user?.role, ["admin", "administrateur", "directeur", "compt", "secr", "secret"])) {
    next();
    return;
  }
  next(new HttpError(403, "FORBIDDEN", "Facturation role required"));
};

const requireFacturationAdmin: RequestHandler = (req, _res, next) => {
  if (hasAnyRole(req.user?.role, ["admin", "administrateur", "directeur"])) {
    next();
    return;
  }
  next(new HttpError(403, "FORBIDDEN", "Facturation admin role required"));
};

router.use(authenticateToken);

router.get("/", listFactures);
router.get("/:id", getFacture);
router.get("/:id/pdf", getFacturePdf);
router.post("/", requireFacturationWrite, createFacture);
router.post("/:id/pdf", requireFacturationWrite, generateFacturePdf);
router.patch("/:id", requireFacturationWrite, updateFacture);
router.delete("/:id", requireFacturationAdmin, deleteFacture);

export default router;
