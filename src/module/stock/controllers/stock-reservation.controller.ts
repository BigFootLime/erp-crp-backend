import type { Request, RequestHandler } from "express";

import { HttpError } from "../../../utils/httpError";
import type { AuditContext } from "../repository/stock.repository";
import {
  consumeStockReservationSchema,
  createStockReservationSchema,
  listStockReservationsQuerySchema,
  stockReservationActionSchema,
} from "../validators/stock-reservation.validators";
import {
  consumeStockReservationSVC,
  createStockReservationSVC,
  getStockReservationSVC,
  listStockReservationsSVC,
  releaseStockReservationSVC,
} from "../services/stock-reservation.service";
import { idParamSchema } from "../validators/stock.validators";

function buildAuditContext(req: Request): AuditContext {
  const user = req.user;
  if (!user) throw new HttpError(401, "UNAUTHORIZED", "Authentication required");
  const forwardedFor = req.headers["x-forwarded-for"];
  const ipFromHeader = typeof forwardedFor === "string" ? forwardedFor.split(",")[0]?.trim() : null;
  return {
    user_id: user.id,
    ip: ipFromHeader ?? req.ip ?? null,
    user_agent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null,
    device_type: null,
    os: null,
    browser: null,
    path: req.originalUrl ?? null,
    page_key: typeof req.headers["x-page-key"] === "string" ? req.headers["x-page-key"] : null,
    client_session_id:
      typeof req.headers["x-client-session-id"] === "string"
        ? req.headers["x-client-session-id"]
        : null,
  };
}

function getRequiredIdempotencyKey(req: Request): string {
  const value = req.headers["idempotency-key"];
  if (typeof value !== "string" || value.trim().length < 8 || value.trim().length > 200) {
    throw new HttpError(
      400,
      "IDEMPOTENCY_KEY_REQUIRED",
      "A valid Idempotency-Key header is required (8 to 200 characters)."
    );
  }
  return value.trim();
}

export const listStockReservations: RequestHandler = async (req, res, next) => {
  try {
    const query = listStockReservationsQuerySchema.parse(req.query);
    res.json(await listStockReservationsSVC(query));
  } catch (error) {
    next(error);
  }
};

export const getStockReservation: RequestHandler = async (req, res, next) => {
  try {
    const { id } = idParamSchema.parse({ params: req.params }).params;
    const out = await getStockReservationSVC(id);
    if (!out) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json(out);
  } catch (error) {
    next(error);
  }
};

export const createStockReservation: RequestHandler = async (req, res, next) => {
  try {
    const body = createStockReservationSchema.parse({ body: req.body }).body;
    const out = await createStockReservationSVC(
      body,
      buildAuditContext(req),
      getRequiredIdempotencyKey(req)
    );
    res.status(201).json(out);
  } catch (error) {
    next(error);
  }
};

export const releaseStockReservation: RequestHandler = async (req, res, next) => {
  try {
    const { id } = idParamSchema.parse({ params: req.params }).params;
    const body = stockReservationActionSchema.parse({ body: req.body }).body;
    const out = await releaseStockReservationSVC(
      id,
      body,
      buildAuditContext(req),
      getRequiredIdempotencyKey(req)
    );
    if (!out) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json(out);
  } catch (error) {
    next(error);
  }
};

export const consumeStockReservation: RequestHandler = async (req, res, next) => {
  try {
    const { id } = idParamSchema.parse({ params: req.params }).params;
    const body = consumeStockReservationSchema.parse({ body: req.body }).body;
    const out = await consumeStockReservationSVC(
      id,
      body,
      buildAuditContext(req),
      getRequiredIdempotencyKey(req)
    );
    if (!out) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json(out);
  } catch (error) {
    next(error);
  }
};
