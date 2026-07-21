import { Router, type RequestHandler } from "express";
import { authenticateToken } from "../../auth/middlewares/auth.middleware";
import { HttpError } from "../../../utils/httpError";
import { roleHasAffaireCapability, type AffaireCapability } from "../domain/affaire-rbac";
import {
  archiveAffaire,
  createAffaire,
  getAffaire,
  getAffaireOperations,
  listAffaires,
  listAffairesCommandCenter,
  previewAffaire,
  transitionAffaire,
  updateAffaire,
} from "../controllers/affaire.controller";

const router = Router();

// Refus par défaut : chaque route exige une capacité distincte, vérifiée côté serveur.
function requireAffaireCapability(capability: AffaireCapability): RequestHandler {
  return (req, _res, next) => {
    if (roleHasAffaireCapability(req.user?.role, capability)) {
      next();
      return;
    }
    next(new HttpError(403, "FORBIDDEN", `Capacité « ${capability} » requise sur les affaires.`));
  };
}

// Transition : capacité coarse selon la cible (close/annulation) ; le RBAC fin dépendant de l'état
// (réouverture) est renforcé dans le service une fois le statut courant connu.
const requireAffaireTransitionCapability: RequestHandler = (req, _res, next) => {
  const role = req.user?.role;
  const to = typeof req.body?.to === "string" ? req.body.to : null;
  let capability: AffaireCapability = "transition";
  if (to === "CLOTUREE") capability = "close";
  else if (to === "ANNULEE") capability = "archive";
  if (roleHasAffaireCapability(role, capability)) {
    next();
    return;
  }
  next(new HttpError(403, "FORBIDDEN", `Capacité « ${capability} » requise pour cette transition.`));
};

router.use(authenticateToken);

// Lectures
router.get("/command-center", requireAffaireCapability("read"), listAffairesCommandCenter);
router.get("/", requireAffaireCapability("read"), listAffaires);
router.get("/:id/operations", requireAffaireCapability("read"), getAffaireOperations);
router.get("/:id", requireAffaireCapability("read"), getAffaire);

// Écritures
router.post("/preview", requireAffaireCapability("write"), previewAffaire);
router.post("/", requireAffaireCapability("write"), createAffaire);
router.patch("/:id", requireAffaireCapability("write"), updateAffaire);
router.post("/:id/transition", requireAffaireTransitionCapability, transitionAffaire);
// Archivage (aucune suppression physique) — remplace l'ancien DELETE /:id.
router.post("/:id/archive", requireAffaireCapability("archive"), archiveAffaire);

export default router;
