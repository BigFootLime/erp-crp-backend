// #210 — HTTP handlers de la bibliothèque de finitions et de la configuration
// d'une opération de gamme. Le contrôleur ne décide de rien : il construit le
// contexte d'audit depuis le TOKEN (jamais depuis le corps de la requête) et
// délègue.

import type { Request, RequestHandler } from "express";

import { HttpError } from "../../../utils/httpError";
import type { AuditContext } from "../../pieces-techniques/repository/pieces-techniques.repository";
import {
  archiveFinishSVC,
  attachRevisionDocumentSVC,
  capabilitiesSVC,
  confirmOperationFinishSVC,
  createFinishFamilySVC,
  createFinishDraftSVC,
  createRevisionSVC,
  detachOperationFinishSVC,
  findSimilarFinishesSVC,
  getFinishSVC,
  getOperationFinishSVC,
  listFinishesSVC,
  listFinishFamiliesSVC,
  listFinishHistorySVC,
  listRevisionDocumentsSVC,
  previewOperationFinishSVC,
  previewStockFinishArticleSVC,
  confirmStockFinishArticleSVC,
  reactivateFinishSVC,
  revisionImpactSVC,
  setFinishFavoriteSVC,
  transitionRevisionSVC,
  updateFinishDraftSVC,
  updateRevisionSVC,
  type Actor,
} from "../services/surface-finish.service";
import type {
  FinishHistoryQueryDTO,
  ListFinishesQueryDTO,
  SimilarFinishesQueryDTO,
} from "../validators/surface-finish.validators";

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

export const createFinishFamily: RequestHandler = async (req, res, next) => {
  try {
    res.status(201).json(await createFinishFamilySVC(req.body, buildAuditContext(req)));
  } catch (err) {
    next(err);
  }
};

export const listFinishes: RequestHandler = async (req, res, next) => {
  try {
    // L'identité du lecteur vient du jeton : c'est elle qui décide de `favori`.
    res.json(await listFinishesSVC(req.query as unknown as ListFinishesQueryDTO, requireUser(req).id));
  } catch (err) {
    next(err);
  }
};

export const getFinish: RequestHandler = async (req, res, next) => {
  try {
    res.json(await getFinishSVC(routeParam(req, "finishId"), requireUser(req).id));
  } catch (err) {
    next(err);
  }
};

/* -------------------------------------------------------------------------- */
/* #226 — Doublons, favoris, archivage, historique                            */
/* -------------------------------------------------------------------------- */

export const listSimilarFinishes: RequestHandler = async (req, res, next) => {
  try {
    res.json(await findSimilarFinishesSVC(req.query as unknown as SimilarFinishesQueryDTO));
  } catch (err) {
    next(err);
  }
};

export const addFinishFavorite: RequestHandler = async (req, res, next) => {
  try {
    res.json(await setFinishFavoriteSVC(routeParam(req, "finishId"), actorOf(req), true));
  } catch (err) {
    next(err);
  }
};

export const removeFinishFavorite: RequestHandler = async (req, res, next) => {
  try {
    res.json(await setFinishFavoriteSVC(routeParam(req, "finishId"), actorOf(req), false));
  } catch (err) {
    next(err);
  }
};

export const archiveFinish: RequestHandler = async (req, res, next) => {
  try {
    res.json(await archiveFinishSVC(routeParam(req, "finishId"), req.body, actorOf(req), buildAuditContext(req)));
  } catch (err) {
    next(err);
  }
};

export const reactivateFinish: RequestHandler = async (req, res, next) => {
  try {
    res.json(await reactivateFinishSVC(routeParam(req, "finishId"), req.body, actorOf(req), buildAuditContext(req)));
  } catch (err) {
    next(err);
  }
};

export const listFinishHistory: RequestHandler = async (req, res, next) => {
  try {
    res.json(
      await listFinishHistorySVC(
        routeParam(req, "finishId"),
        req.query as unknown as FinishHistoryQueryDTO,
        actorOf(req)
      )
    );
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

/** Stock exige une PT/version explicite ; le moteur génère toujours les textes côté serveur. */
export const previewStockFinishArticle: RequestHandler = async (req, res, next) => {
  try {
    res.json(await previewStockFinishArticleSVC(req.body, actorOf(req)));
  } catch (err) {
    next(err);
  }
};

export const confirmStockFinishArticle: RequestHandler = async (req, res, next) => {
  try {
    const result = await confirmStockFinishArticleSVC(
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
