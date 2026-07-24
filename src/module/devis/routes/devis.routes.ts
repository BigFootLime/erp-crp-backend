import type { RequestHandler } from "express";
import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { HttpError } from "../../../utils/httpError";
import { ensureDocumentStoragePath } from "../../../utils/cerpStorage";
import {
  DEVIS_TRANSITION_CAPABILITIES,
  roleHasDevisCapability,
  type DevisCapability,
} from "../domain/devis-rbac";
import {
  createDevis,
  convertDevisToCommande,
  deleteDevis,
  findDevisByArticle,
  findDevisByArticleDevisCode,
  getCommandeDraftFromDevis,
  getDevis,
  getDevisDocumentFile,
  listDevis,
  listDevisVersions,
  reviseDevis,
  updateDevis,
} from "../controllers/devis.controller";
import { createDevisBodySchema, updateDevisBodySchema } from "../validators/devis.validators";

declare global {
  namespace Express {
    interface Request {
      parsedDevisBody?: unknown;
    }
  }
}

const uploadDir = ensureDocumentStoragePath();
const upload = multer({ dest: uploadDir });

const parseMultipartData = (schema: z.ZodTypeAny): RequestHandler => {
  return (req, _res, next) => {
    const raw = (req.body as { data?: unknown } | undefined)?.data;
    if (typeof raw !== "string" || raw.trim() === "") {
      next(new HttpError(400, "MISSING_DATA", "Missing data field"));
      return;
    }

    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      next(new HttpError(400, "BAD_JSON", "Invalid JSON in data field"));
      return;
    }

    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      const msg = parsed.error.issues?.[0]?.message ?? "Invalid request";
      next(new HttpError(422, "VALIDATION_ERROR", msg, parsed.error.flatten()));
      return;
    }

    req.parsedDevisBody = parsed.data;
    next();
  };
};

/**
 * Gardes RBAC devis (#167) — montées derrière le socle default-deny (`authenticateToken`
 * global de v1.routes.ts). Chaque action porte une garde de capacité refusée par défaut ;
 * le RBAC fin dépendant de l'état (transition de statut) est re-vérifié dans le repository
 * une fois l'état source connu (pattern #169/#172). Masquer un bouton n'est jamais une
 * autorisation.
 */
function requireCapability(capability: DevisCapability): RequestHandler {
  return (req, _res, next) => {
    if (!roleHasDevisCapability(req.user?.role, capability)) {
      next(new HttpError(403, "FORBIDDEN", "Votre rôle ne permet pas cette action sur les devis."));
      return;
    }
    next();
  };
}

/** Garde grossière du PATCH : brouillon OU au moins une capacité de transition (le repo tranche). */
const requireUpdateOrTransitionCapability: RequestHandler = (req, _res, next) => {
  const role = req.user?.role;
  if (
    roleHasDevisCapability(role, "update_draft") ||
    DEVIS_TRANSITION_CAPABILITIES.some((cap) => roleHasDevisCapability(role, cap))
  ) {
    next();
    return;
  }
  next(new HttpError(403, "FORBIDDEN", "Votre rôle ne permet aucune modification de devis."));
};

const router = Router();

router.get("/", requireCapability("read"), listDevis);
router.get("/by-article/:articleId", requireCapability("read"), findDevisByArticle);
router.get("/by-article-devis-code/:code", requireCapability("read"), findDevisByArticleDevisCode);
router.get("/:id", requireCapability("read"), getDevis);
router.get("/:id/versions", requireCapability("read"), listDevisVersions);
router.get("/:id/commande-draft", requireCapability("convert"), getCommandeDraftFromDevis);
router.get("/:id/documents/:docId/file", requireCapability("export"), getDevisDocumentFile);
router.post("/", requireCapability("create"), upload.array("documents[]"), parseMultipartData(createDevisBodySchema), createDevis);
router.post("/:id/convert-to-commande", requireCapability("convert"), convertDevisToCommande);
router.post("/:id/revise", requireCapability("revise"), upload.array("documents[]"), parseMultipartData(updateDevisBodySchema), reviseDevis);
router.patch("/:id", requireUpdateOrTransitionCapability, upload.array("documents[]"), parseMultipartData(updateDevisBodySchema), updateDevis);
router.delete("/:id", requireCapability("delete"), deleteDevis);

export default router;
