import type { Request, RequestHandler } from "express";
import { HttpError } from "../../../utils/httpError";
import { getClientIp, parseDevice } from "../../../utils/requestMeta";
import {
  affaireIdParamsSchema,
  archiveAffaireBodySchema,
  createAffaireBodySchema,
  getAffaireQuerySchema,
  listAffairesCommandCenterQuerySchema,
  listAffairesQuerySchema,
  previewAffaireBodySchema,
  transitionAffaireBodySchema,
  updateAffaireBodySchema,
} from "../validators/affaire.validators";
import type { AuditContext } from "../types/affaire.types";
import {
  svcArchiveAffaire,
  svcCreateAffaire,
  svcGetAffaire,
  svcGetAffaireOperations,
  svcListAffairesCommandCenter,
  svcListAffaires,
  svcPreviewAffaire,
  svcTransitionAffaire,
  svcUpdateAffaire,
} from "../services/affaire.service";

function buildAuditContext(req: Request): AuditContext {
  const user = req.user;
  if (!user || typeof user.id !== "number") {
    throw new HttpError(401, "UNAUTHORIZED", "Authentication required");
  }

  const userAgent = typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null;
  const device = parseDevice(userAgent);
  const pageKey = typeof req.headers["x-page-key"] === "string" ? req.headers["x-page-key"] : "affaires";
  const clientSessionId =
    typeof req.headers["x-client-session-id"] === "string"
      ? req.headers["x-client-session-id"]
      : typeof req.headers["x-session-id"] === "string"
        ? req.headers["x-session-id"]
        : null;

  return {
    user_id: user.id,
    user_role: typeof user.role === "string" ? user.role : null,
    ip: getClientIp(req),
    user_agent: userAgent,
    device_type: device.device_type,
    os: device.os,
    browser: device.browser,
    path: req.originalUrl ?? null,
    page_key: pageKey,
    client_session_id: clientSessionId,
  };
}

export const listAffaires: RequestHandler = async (req, res, next) => {
  try {
    const query = listAffairesQuerySchema.parse(req.query);
    const out = await svcListAffaires(query);
    res.json(out);
  } catch (err) {
    next(err);
  }
};

export const listAffairesCommandCenter: RequestHandler = async (req, res, next) => {
  try {
    const query = listAffairesCommandCenterQuerySchema.parse(req.query);
    const out = await svcListAffairesCommandCenter(query);
    res.json(out);
  } catch (err) {
    next(err);
  }
};

export const getAffaire: RequestHandler = async (req, res, next) => {
  try {
    const { id } = affaireIdParamsSchema.parse(req.params);
    const { include } = getAffaireQuerySchema.parse(req.query);

    const affaire = await svcGetAffaire(id, include);
    if (!affaire) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    res.json({ affaire });
  } catch (err) {
    next(err);
  }
};

export const getAffaireOperations: RequestHandler = async (req, res, next) => {
  try {
    const { id } = affaireIdParamsSchema.parse(req.params);
    const out = await svcGetAffaireOperations(id);
    if (!out) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    res.json(out);
  } catch (err) {
    next(err);
  }
};

// Aperçu de création manuelle : lecture seule, aucun effet de bord (ne consomme pas de code).
export const previewAffaire: RequestHandler = async (req, res, next) => {
  try {
    const dto = previewAffaireBodySchema.parse(req.body ?? {});
    const out = await svcPreviewAffaire(dto);
    res.status(200).json(out);
  } catch (err) {
    next(err);
  }
};

export const createAffaire: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req);
    const dto = createAffaireBodySchema.parse(req.body);
    const out = await svcCreateAffaire(dto, audit);
    res.status(201).json(out);
  } catch (err) {
    next(err);
  }
};

export const updateAffaire: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req);
    const { id } = affaireIdParamsSchema.parse(req.params);
    const dto = updateAffaireBodySchema.parse(req.body);
    // `expected_updated_at` est un jeton de verrou, pas un champ modifiable.
    const { expected_updated_at, ...mutations } = dto;
    void expected_updated_at;
    if (Object.keys(mutations).length === 0) {
      res.status(400).json({ error: "No fields to update" });
      return;
    }

    const out = await svcUpdateAffaire(id, dto, audit);
    if (!out) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.status(200).json(out);
  } catch (err) {
    next(err);
  }
};

// Transition d'état serveur (machine d'état). Transition interdite -> 422 INVALID_TRANSITION.
export const transitionAffaire: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req);
    const { id } = affaireIdParamsSchema.parse(req.params);
    const dto = transitionAffaireBodySchema.parse(req.body);
    const out = await svcTransitionAffaire(id, dto, audit);
    if (!out) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.status(200).json(out);
  } catch (err) {
    next(err);
  }
};

// Archivage (aucune suppression physique). Remplace l'ancien DELETE.
export const archiveAffaire: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req);
    const { id } = affaireIdParamsSchema.parse(req.params);
    const dto = archiveAffaireBodySchema.parse(req.body ?? {});
    const out = await svcArchiveAffaire(id, dto, audit);
    if (!out) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.status(200).json(out);
  } catch (err) {
    next(err);
  }
};
