import type { Request, RequestHandler } from "express";

import { HttpError } from "../../../utils/httpError";
import {
  createCalendarClosureSVC,
  createProductionCalendarSVC,
  deleteCalendarClosureSVC,
  listProductionCalendarsSVC,
  readProductionReadinessSVC,
  updateProductionCalendarSVC,
} from "../services/production-readiness.service";
import type { ProductionReadinessAuditContext } from "../types/production-readiness.types";
import {
  productionCalendarClosureSchema,
  productionCalendarSchema,
  updateProductionCalendarSchema,
} from "../validators/production-readiness.validators";

function requiredParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new HttpError(400, "INVALID_ROUTE_PARAM", `Paramètre de route invalide : ${name}`);
  }
  return value;
}

export function buildProductionReadinessAuditContext(req: Request): ProductionReadinessAuditContext {
  if (!req.user) throw new HttpError(401, "UNAUTHORIZED", "Authentification requise.");
  const forwardedFor = req.headers["x-forwarded-for"];
  return {
    user_id: req.user.id,
    role: req.user.role ?? null,
    ip: typeof forwardedFor === "string" ? forwardedFor.split(",")[0]?.trim() ?? null : req.ip ?? null,
    user_agent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null,
    device_type: null,
    os: null,
    browser: null,
    path: req.originalUrl ?? null,
    page_key: typeof req.headers["x-page-key"] === "string" ? req.headers["x-page-key"] : null,
    client_session_id:
      typeof req.headers["x-client-session-id"] === "string"
        ? req.headers["x-client-session-id"]
        : typeof req.headers["x-session-id"] === "string"
          ? req.headers["x-session-id"]
          : null,
  };
}

export const readProductionReadiness: RequestHandler = async (req, res, next) => {
  try {
    res.json(await readProductionReadinessSVC(req.user?.role));
  } catch (error) {
    next(error);
  }
};
export const listProductionCalendars: RequestHandler = async (_req, res, next) => {
  try {
    res.json({ calendars: await listProductionCalendarsSVC() });
  } catch (error) {
    next(error);
  }
};

export const createProductionCalendar: RequestHandler = async (req, res, next) => {
  try {
    const result = await createProductionCalendarSVC(
      productionCalendarSchema.parse(req.body),
      buildProductionReadinessAuditContext(req)
    );
    res.status(result.created ? 201 : 200).json({ ...result.calendar, replayed: !result.created });
  } catch (error) {
    next(error);
  }
};

export const updateProductionCalendar: RequestHandler = async (req, res, next) => {
  try {
    res.json(
      await updateProductionCalendarSVC(
        requiredParam(req, "calendarId"),
        updateProductionCalendarSchema.parse(req.body),
        buildProductionReadinessAuditContext(req)
      )
    );
  } catch (error) {
    next(error);
  }
};

export const createCalendarClosure: RequestHandler = async (req, res, next) => {
  try {
    const result = await createCalendarClosureSVC(
      requiredParam(req, "calendarId"),
      productionCalendarClosureSchema.parse(req.body),
      buildProductionReadinessAuditContext(req)
    );
    res.status(result.created ? 201 : 200).json({ ...result.calendar, replayed: !result.created });
  } catch (error) {
    next(error);
  }
};

export const deleteCalendarClosure: RequestHandler = async (req, res, next) => {
  try {
    await deleteCalendarClosureSVC(
      requiredParam(req, "calendarId"),
      requiredParam(req, "closureId"),
      buildProductionReadinessAuditContext(req)
    );
    res.status(204).send();
  } catch (error) {
    next(error);
  }
};
