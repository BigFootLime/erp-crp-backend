import type { Request, RequestHandler } from "express";
import { HttpError } from "../../../utils/httpError";
import { getClientIp, parseDevice } from "../../../utils/requestMeta";
import {
  affaireIdParamsSchema,
  createAffaireBodySchema,
  getAffaireQuerySchema,
  listAffairesCommandCenterQuerySchema,
  listAffairesQuerySchema,
  updateAffaireBodySchema,
} from "../validators/affaire.validators";
import type { AuditContext } from "../types/affaire.types";
import {
  svcCreateAffaire,
  svcDeleteAffaire,
  svcGetAffaire,
  svcGetAffaireOperations,
  svcListAffairesCommandCenter,
  svcListAffaires,
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
    if (Object.keys(dto).length === 0) {
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

export const deleteAffaire: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildAuditContext(req);
    const { id } = affaireIdParamsSchema.parse(req.params);
    const ok = await svcDeleteAffaire(id, audit);
    if (!ok) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.status(204).send();
  } catch (err) {
    next(err);
  }
};
