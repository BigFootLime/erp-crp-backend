import { Router, type RequestHandler } from "express";

import { HttpError } from "../../../utils/httpError";
import {
  roleHasCommandeFournisseurCapability,
  type CommandeFournisseurCapability,
} from "../domain/commande-fournisseur-rbac";
import {
  accuseReception,
  addLigne,
  confirmPropositions,
  createCommandeFournisseur,
  deleteLigne,
  duplicateCommandeFournisseur,
  generateDocument,
  getCommandeFournisseur,
  getCommandeFournisseurKpis,
  getDocument,
  listCommandesFournisseurs,
  previewPropositions,
  reorderLignes,
  resyncReceptions,
  simulateTotaux,
  transitionCommandeFournisseur,
  updateCommandeFournisseur,
  updateLigne,
} from "../controllers/commande-fournisseur.controller";

/**
 * Routes commandes fournisseurs (#172) — montées derrière le socle default-deny
 * (`authenticateToken` global de v1.routes.ts). Chaque écriture porte en plus une garde
 * de capacité RBAC refusée par défaut ; le RBAC fin dépendant de l'état (transition) est
 * re-vérifié dans le repository une fois l'état source connu (pattern affaire #169).
 * Masquer un bouton frontend n'est jamais une autorisation.
 */
function requireCapability(capability: CommandeFournisseurCapability): RequestHandler {
  return (req, _res, next) => {
    if (!roleHasCommandeFournisseurCapability(req.user?.role, capability)) {
      next(new HttpError(403, "FORBIDDEN", "Votre rôle ne permet pas cette action sur les commandes fournisseurs."));
      return;
    }
    next();
  };
}

/** Garde coarse de transition : la capacité fine est re-vérifiée dans le repo (état connu). */
const requireAnyTransitionCapability: RequestHandler = (req, _res, next) => {
  const role = req.user?.role;
  const capabilities: CommandeFournisseurCapability[] = ["submit", "approve", "send", "acknowledge", "cancel", "close"];
  if (!capabilities.some((cap) => roleHasCommandeFournisseurCapability(role, cap))) {
    next(new HttpError(403, "FORBIDDEN", "Votre rôle ne permet aucune transition de commande fournisseur."));
    return;
  }
  next();
};

const router = Router();

router.get("/", requireCapability("read"), listCommandesFournisseurs);
router.get("/kpis", requireCapability("read"), getCommandeFournisseurKpis);

router.post("/", requireCapability("create"), createCommandeFournisseur);
router.post("/totaux/simulate", requireCapability("read"), simulateTotaux);

router.post("/propositions/preview", requireCapability("create"), previewPropositions);
router.post("/propositions/confirm", requireCapability("create"), confirmPropositions);

router.get("/:id", requireCapability("read"), getCommandeFournisseur);
router.patch("/:id", requireCapability("update_draft"), updateCommandeFournisseur);

router.post("/:id/lignes", requireCapability("update_draft"), addLigne);
router.post("/:id/lignes/reorder", requireCapability("update_draft"), reorderLignes);
router.patch("/:id/lignes/:ligneId", requireCapability("update_draft"), updateLigne);
router.delete("/:id/lignes/:ligneId", requireCapability("update_draft"), deleteLigne);

router.post("/:id/transition", requireAnyTransitionCapability, transitionCommandeFournisseur);
router.post("/:id/accuse", requireCapability("acknowledge"), accuseReception);

router.post("/:id/documents", requireCapability("send"), generateDocument);
router.get("/:id/documents/:documentId", requireCapability("read"), getDocument);

router.post("/:id/receptions/resync", requireCapability("read"), resyncReceptions);
router.post("/:id/duplicate", requireCapability("create"), duplicateCommandeFournisseur);

export default router;
