import type { Request, RequestHandler } from "express";
import type { z } from "zod";

import { HttpError } from "../../../utils/httpError";
import { requestHasGrantedAccountModuleAccess } from "../../access-control/context/account-module-access.context";
import { roleHasStockCapability } from "../../stock/domain/stock-rbac";
import {
  repoCreateStockIntelligencePolicy,
  repoSimulateStockIntelligence,
  repoStockIntelligenceOverview,
  type StockIntelligenceActor,
} from "../repository/stock-intelligence.repository";
import {
  stockIntelligenceOverviewQuerySchema,
  stockIntelligencePolicyBodySchema,
  stockIntelligenceSimulationBodySchema,
} from "../validators/stock-intelligence.validators";

function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new HttpError(422, "VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Demande invalide.", parsed.error.flatten());
  }
  return parsed.data;
}

function actorFrom(req: Request): StockIntelligenceActor {
  if (!req.user) throw new HttpError(401, "UNAUTHORIZED", "Authentification requise.");
  const forwarded = req.headers["x-forwarded-for"];
  return {
    user_id: req.user.id,
    role: req.user.role ?? null,
    ip: typeof forwarded === "string" ? forwarded.split(",")[0]?.trim() ?? null : req.ip ?? null,
    user_agent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null,
    path: req.originalUrl ?? null,
    page_key: typeof req.headers["x-page-key"] === "string" ? req.headers["x-page-key"] : null,
    client_session_id: typeof req.headers["x-client-session-id"] === "string" ? req.headers["x-client-session-id"] : null,
  };
}

function idempotencyKeyFrom(req: Request): string {
  const key = req.headers["idempotency-key"];
  if (typeof key !== "string" || key.trim().length < 8 || key.trim().length > 120) {
    throw new HttpError(400, "IDEMPOTENCY_KEY_REQUIRED", "L'en-tête Idempotency-Key (8 à 120 caractères) est obligatoire.");
  }
  return key.trim();
}

export const stockIntelligenceOverview: RequestHandler = async (req, res, next) => {
  try {
    actorFrom(req);
    const includeCosts = requestHasGrantedAccountModuleAccess(req) || roleHasStockCapability(req.user?.role, "costs_read");
    res.setHeader("Cache-Control", "no-store, private");
    res.json(await repoStockIntelligenceOverview(parse(stockIntelligenceOverviewQuerySchema, req.query), includeCosts));
  } catch (error) {
    next(error);
  }
};

export const simulateStockIntelligence: RequestHandler = async (req, res, next) => {
  try {
    actorFrom(req);
    res.setHeader("Cache-Control", "no-store, private");
    res.json(await repoSimulateStockIntelligence(parse(stockIntelligenceSimulationBodySchema, req.body)));
  } catch (error) {
    next(error);
  }
};

export const createStockIntelligencePolicy: RequestHandler = async (req, res, next) => {
  try {
    res.status(201).json(await repoCreateStockIntelligencePolicy({
      input: parse(stockIntelligencePolicyBodySchema, req.body),
      actor: actorFrom(req),
      idempotencyKey: idempotencyKeyFrom(req),
    }));
  } catch (error) {
    next(error);
  }
};
