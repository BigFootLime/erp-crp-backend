// #210 — HTTP handlers de la bibliothèque de finitions et de la configuration
// d'une opération de gamme. Le contrôleur ne décide de rien : il construit le
// contexte d'audit depuis le TOKEN (jamais depuis le corps de la requête) et
// délègue.

import type { Request, RequestHandler } from "express";

import { HttpError } from "../../../utils/httpError";
import type { AuditContext } from "../../pieces-techniques/repository/pieces-techniques.repository";
import {
  attachRevisionDocumentSVC,
  capabilitiesSVC,
  confirmOperationFinishSVC,
  createFinishDraftSVC,
  createRevisionSVC,
  detachOperationFinishSVC,
  getFinishSVC,
  getOperationFinishSVC,
  listFinishesSVC,
  listFinishFamiliesSVC,
  listRevisionDocumentsSVC,
  previewOperationFinishSVC,
  revisionImpactSVC,
  transitionRevisionSVC,
  updateFinishDraftSVC,
  updateRevisionSVC,
  type Actor,
} from "../services/surface-finish.service";
import type { ListFinishesQueryDTO } from "../validators/surface-finish.validators";

function requireUser(req: Request): { id: number; role: string | null } {
  const user = req.user;
  if (!user || typeof user.id !== "number") {
    throw new HttpError(401, "UNAUTHORIZED", "Authentification requise.");
  }
  return { id: user.id, role: typeof user.role === "string" ? user.role : null };
}

/** L'identité vient du jeton. Aucun champ libre du corps ne peut la remplacer. */
function buildAuditContext(req: Request): AuditContext {
  const user = requireUser(req);
  const forwardedFor = req.headers["x-forwarded-for"];
  const ipFromHeader = typeof forwardedFor === "string" ? forwardedFor.split(",")[0]?.trim() : null;
  const ua = typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null;
  const pageKey = typeof req.headers["x-page-key"] === "string" ? req.headers["x-page-key"] : null;
  const clientSessionId =
    typeof req.headers["x-client-session-id"] === "string"
      ? req.headers["x-client-session-id"]
      : typeof req.headers["x-session-id"] === "string"
        ? req.headers["x-session-id"]
        : null;
  return {
    user_id: user.id,
    ip: ipFromHeader ?? req.ip ?? null,
    user_agent: ua,
    device_type: null,
    os: null,
    browser: null,
    path: req.originalUrl ?? null,
    page_key: pageKey,
    client_session_id: clientSessionId,
  };
}

function actorOf(req: Request): Actor {
  const user = requireUser(req);
  return { user_id: user.id, role: user.role };
}

function routeParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new HttpError(400, "INVALID_ROUTE_PARAM", `Paramètre de route invalide : ${name}`);
  }
  return value;
}

function headerValue(req: Request, name: string): string | null {
  const raw = req.headers[name];
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw) && typeof raw[0] === "string") return raw[0];
  return null;
}

/* -------------------------------------------------------------------------- */
/* Bibliothèque                                                                */
/* -------------------------------------------------------------------------- */

export const listFinishFamilies: RequestHandler = async (_req, res, next) => {
  try {
    res.json(await listFinishFamiliesSVC());
  } catch (err) {
    next(err);
  }
};

export const listFinishes: RequestHandler = async (req, res, next) => {
  try {
    res.json(await listFinishesSVC(req.query as unknown as ListFinishesQueryDTO));
  } catch (err) {
    next(err);
  }
};

export const getFinish: RequestHandler = async (req, res, next) => {
  try {
    res.json(await getFinishSVC(routeParam(req, "finishId")));
  } catch (err) {
    next(err);
  }
};

export const createFinish: RequestHandler = async (req, res, next) => {
  try {
    const created = await createFinishDraftSVC(req.body, buildAuditContext(req));
    res.status(201).json(created);
  } catch (err) {
    next(err);
  }
};

export const updateFinish: RequestHandler = async (req, res, next) => {
  try {
    res.json(await updateFinishDraftSVC(routeParam(req, "finishId"), req.body, buildAuditContext(req)));
  } catch (err) {
    next(err);
  }
};

export const createRevision: RequestHandler = async (req, res, next) => {
  try {
    const created = await createRevisionSVC(routeParam(req, "finishId"), req.body, buildAuditContext(req));
    res.status(201).json(created);
  } catch (err) {
    next(err);
  }
};

export const updateRevision: RequestHandler = async (req, res, next) => {
  try {
    res.json(await updateRevisionSVC(routeParam(req, "revisionId"), req.body, buildAuditContext(req)));
  } catch (err) {
    next(err);
  }
};

export const transitionRevision: RequestHandler = async (req, res, next) => {
  try {
    res.json(
      await transitionRevisionSVC(routeParam(req, "revisionId"), req.body, buildAuditContext(req), actorOf(req))
    );
  } catch (err) {
    next(err);
  }
};

export const revisionImpact: RequestHandler = async (req, res, next) => {
  try {
    res.json(await revisionImpactSVC(routeParam(req, "revisionId")));
  } catch (err) {
    next(err);
  }
};

export const listRevisionDocuments: RequestHandler = async (req, res, next) => {
  try {
    res.json(await listRevisionDocumentsSVC(routeParam(req, "revisionId")));
  } catch (err) {
    next(err);
  }
};

export const attachRevisionDocument: RequestHandler = async (req, res, next) => {
  try {
    const created = await attachRevisionDocumentSVC(routeParam(req, "revisionId"), req.body, buildAuditContext(req));
    res.status(201).json(created);
  } catch (err) {
    next(err);
  }
};

export const readCapabilities: RequestHandler = async (req, res, next) => {
  try {
    res.json(capabilitiesSVC(actorOf(req)));
  } catch (err) {
    next(err);
  }
};

/* -------------------------------------------------------------------------- */
/* Configuration d'une opération de gamme                                      */
/* -------------------------------------------------------------------------- */

export const getOperationFinish: RequestHandler = async (req, res, next) => {
  try {
    const requirement = await getOperationFinishSVC(routeParam(req, "gammeId"), routeParam(req, "operationId"));
    res.json(requirement);
  } catch (err) {
    next(err);
  }
};

/** Aperçu : LECTURE PURE. Aucune écriture n'est déclenchée par cet appel. */
export const previewOperationFinish: RequestHandler = async (req, res, next) => {
  try {
    const preview = await previewOperationFinishSVC(
      routeParam(req, "gammeId"),
      routeParam(req, "operationId"),
      req.body,
      actorOf(req)
    );
    res.json(preview);
  } catch (err) {
    next(err);
  }
};

export const confirmOperationFinish: RequestHandler = async (req, res, next) => {
  try {
    const result = await confirmOperationFinishSVC(
      routeParam(req, "gammeId"),
      routeParam(req, "operationId"),
      req.body,
      buildAuditContext(req),
      actorOf(req),
      headerValue(req, "idempotency-key")
    );
    res.status(result.result === "CREATED" ? 201 : 200).json(result);
  } catch (err) {
    next(err);
  }
};

export const detachOperationFinish: RequestHandler = async (req, res, next) => {
  try {
    res.json(
      await detachOperationFinishSVC(
        routeParam(req, "gammeId"),
        routeParam(req, "operationId"),
        req.body,
        buildAuditContext(req)
      )
    );
  } catch (err) {
    next(err);
  }
};
