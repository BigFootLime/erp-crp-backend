import { Router, type RequestHandler } from "express";
import { authenticateToken } from "../../auth/middlewares/auth.middleware";
import { HttpError } from "../../../utils/httpError";
import {
  createAffaire,
  deleteAffaire,
  getAffaire,
  getAffaireOperations,
  listAffaires,
  listAffairesCommandCenter,
  updateAffaire,
} from "../controllers/affaire.controller";

const router = Router();

function hasAnyRole(role: string | undefined, needles: string[]): boolean {
  if (!role) return false;
  const normalized = role.trim().toLowerCase();
  return needles.some((needle) => normalized.includes(needle));
}

const requireAffairesWrite: RequestHandler = (req, _res, next) => {
  if (
    hasAnyRole(req.user?.role, [
      "admin",
      "administrateur",
      "directeur",
      "secr",
      "secret",
      "commercial",
      "logistique",
      "production",
      "atelier",
      "compt",
    ])
  ) {
    next();
    return;
  }
  next(new HttpError(403, "FORBIDDEN", "Affaires write role required"));
};

const requireAffairesAdmin: RequestHandler = (req, _res, next) => {
  if (hasAnyRole(req.user?.role, ["admin", "administrateur", "directeur"])) {
    next();
    return;
  }
  next(new HttpError(403, "FORBIDDEN", "Affaires admin role required"));
};

router.use(authenticateToken);

router.get("/command-center", listAffairesCommandCenter);
router.get("/", listAffaires);
router.get("/:id/operations", getAffaireOperations);
router.get("/:id", getAffaire);
router.post("/", requireAffairesWrite, createAffaire);
router.patch("/:id", requireAffairesWrite, updateAffaire);
router.delete("/:id", requireAffairesAdmin, deleteAffaire);

export default router;
