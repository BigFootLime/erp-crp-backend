import type { Request, Response } from "express";
import { asyncHandler } from "../../../utils/asyncHandler";
import { HttpError } from "../../../utils/httpError";
import { getClientIp, parseDevice } from "../../../utils/requestMeta";
import type { AuditContext } from "../repository/temps-deplacements.repository";
import * as repo from "../repository/temps-deplacements.repository";
import * as svc from "../services/temps-deplacements.service";
import type { HrEmployeeLite } from "../types/temps-deplacements.types";
import {
  createTimeEventSchema,
  deviceEventSchema,
  deviceHeartbeatSchema,
  employeeIdParamsSchema,
  meAnomaliesQuerySchema,
  meTodayQuerySchema,
  meWeekQuerySchema,
} from "../validators/temps-deplacements.validators";

function buildAuditContext(req: Request): AuditContext {
  const user = req.user;
  if (!user || typeof user.id !== "number") {
    throw new HttpError(401, "UNAUTHORIZED", "Authentication required");
  }
  const userAgent = typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null;
  const ip = getClientIp(req);
  const device = parseDevice(userAgent);
  const pageKey = typeof req.headers["x-page-key"] === "string" ? req.headers["x-page-key"] : null;
  const clientSessionId =
    typeof req.headers["x-client-session-id"] === "string"
      ? req.headers["x-client-session-id"]
      : typeof req.headers["x-session-id"] === "string"
        ? req.headers["x-session-id"]
        : null;
  return {
    user_id: user.id,
    ip,
    user_agent: userAgent,
    device_type: device.device_type,
    os: device.os,
    browser: device.browser,
    path: req.originalUrl ?? null,
    page_key: pageKey,
    client_session_id: clientSessionId,
  };
}

function requireUser(req: Request): { id: number; role: string } {
  const user = req.user;
  if (!user || typeof user.id !== "number") throw new HttpError(401, "UNAUTHORIZED", "Authentification requise.");
  return { id: user.id, role: typeof user.role === "string" ? user.role : "" };
}

// RBAC lecture d'un employé : soi-même, OU son manager, OU un rôle RH/Direction/Admin.
export function isHrPrivileged(role: string): boolean {
  const r = role.toLowerCase();
  return r.includes("rh") || r.includes("directeur") || r.includes("direction") || r.includes("administrateur");
}
export function validateManagerScope(reqUser: { id: number; role: string }, target: HrEmployeeLite): boolean {
  return target.manager_user_id !== null && target.manager_user_id === reqUser.id;
}
// Lève 403 si l'appelant n'a pas le droit de lire cet employé (anti-IDOR).
export function validateEmployeeAccess(reqUser: { id: number; role: string }, target: HrEmployeeLite): void {
  const self = target.user_id === reqUser.id;
  if (self || validateManagerScope(reqUser, target) || isHrPrivileged(reqUser.role)) return;
  throw new HttpError(403, "HR_FORBIDDEN", "Accès refusé aux données de cet employé.");
}
const assertCanReadEmployee = validateEmployeeAccess;

function mondayOf(ymd: string): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  const dow = d.getUTCDay(); // 0=dim..6=sam
  const back = (dow + 6) % 7; // vers lundi
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}

// ------------------------------------------------------------------ Salarié (JWT socle)
export const postEvent = asyncHandler(async (req: Request, res: Response) => {
  const reqUser = requireUser(req);
  const body = createTimeEventSchema.parse(req.body);
  const emp = await svc.resolveEmployeeFromUser(reqUser.id);
  const result = await svc.createTimeEvent(
    { employee_id: emp.id, event_type: body.event_type, event_time: body.event_time, source: "WEB" },
    buildAuditContext(req)
  );
  res.status(201).json(result);
});

export const getMeToday = asyncHandler(async (req: Request, res: Response) => {
  const reqUser = requireUser(req);
  const { date } = meTodayQuerySchema.parse(req.query);
  const emp = await svc.resolveEmployeeFromUser(reqUser.id);
  res.json(await svc.computeDailyTimesheet(emp.id, date ?? svc.todayParis()));
});

export const getMeWeek = asyncHandler(async (req: Request, res: Response) => {
  const reqUser = requireUser(req);
  const { week_start } = meWeekQuerySchema.parse(req.query);
  const emp = await svc.resolveEmployeeFromUser(reqUser.id);
  res.json(await svc.computeWeeklyTimesheet(emp.id, week_start ?? mondayOf(svc.todayParis())));
});

export const getMeAnomalies = asyncHandler(async (req: Request, res: Response) => {
  const reqUser = requireUser(req);
  const filters = meAnomaliesQuerySchema.parse(req.query);
  const emp = await svc.resolveEmployeeFromUser(reqUser.id);
  res.json(await svc.listMyAnomalies(emp.id, filters));
});

// Lecture périmètre (manager/RH) + garde ANTI-IDOR (un salarié ne peut pas lire un autre).
export const getEmployeeToday = asyncHandler(async (req: Request, res: Response) => {
  const reqUser = requireUser(req);
  const { id } = employeeIdParamsSchema.parse(req.params);
  const { date } = meTodayQuerySchema.parse(req.query);
  const target = await repo.repoGetEmployeeById(id);
  if (!target) throw new HttpError(404, "HR_EMPLOYEE_NOT_FOUND", "Employé introuvable.");
  assertCanReadEmployee(reqUser, target);
  res.json(await svc.computeDailyTimesheet(target.id, date ?? svc.todayParis()));
});

export const getEmployeeWeek = asyncHandler(async (req: Request, res: Response) => {
  const reqUser = requireUser(req);
  const { id } = employeeIdParamsSchema.parse(req.params);
  const { week_start } = meWeekQuerySchema.parse(req.query);
  const target = await repo.repoGetEmployeeById(id);
  if (!target) throw new HttpError(404, "HR_EMPLOYEE_NOT_FOUND", "Employé introuvable.");
  assertCanReadEmployee(reqUser, target);
  res.json(await svc.computeWeeklyTimesheet(target.id, week_start ?? mondayOf(svc.todayParis())));
});

// ------------------------------------------------------------------ Borne / device (JWT socle + device_token)
async function authenticateDevice(deviceToken: string | undefined): Promise<{ id: string }> {
  if (!deviceToken) throw new HttpError(401, "HR_DEVICE_UNAUTHORIZED", "device_token requis.");
  const device = await repo.repoGetActiveDeviceByTokenHash(svc.hashDeviceToken(deviceToken));
  if (!device) throw new HttpError(401, "HR_DEVICE_UNAUTHORIZED", "Borne non autorisée.");
  return device;
}

export const postDeviceEvent = asyncHandler(async (req: Request, res: Response) => {
  requireUser(req);
  const body = deviceEventSchema.parse(req.body);
  const device = await authenticateDevice(body.device_token);
  const audit = buildAuditContext(req);
  let emp: HrEmployeeLite;
  try {
    emp = await svc.resolveEmployeeFromBadge(body.badge_uid); // badge_uid haché serveur ; jamais loggé
  } catch (err) {
    // Badge inconnu/révoqué : audité SANS le badge_uid brut.
    await repo.withTransaction((client) =>
      repo.insertAuditLog(client, audit, {
        action: "temps-deplacements.event.refused",
        entity_type: "hr_time_clock_devices",
        entity_id: device.id,
        details: { reason: err instanceof HttpError ? err.code : "UNKNOWN", event_type: body.event_type },
      })
    );
    throw err;
  }
  const result = await svc.createTimeEvent(
    {
      employee_id: emp.id,
      event_type: body.event_type,
      event_time: body.event_time,
      source: "BADGE",
      device_id: device.id,
      idempotency_key: body.idempotency_key,
    },
    audit
  );
  res.status(201).json(result);
});

export const postDeviceHeartbeat = asyncHandler(async (req: Request, res: Response) => {
  requireUser(req);
  const body = deviceHeartbeatSchema.parse(req.body);
  const device = await authenticateDevice(body.device_token);
  await repo.repoTouchDeviceHeartbeat(device.id);
  await repo.withTransaction((client) =>
    repo.insertAuditLog(client, buildAuditContext(req), {
      action: "temps-deplacements.device.heartbeat",
      entity_type: "hr_time_clock_devices",
      entity_id: device.id,
      details: null,
    })
  );
  res.json({ ok: true, device_id: device.id });
});

// Config borne — AUCUNE donnée RH sensible (types d'événements + cadence heartbeat).
export const getDeviceConfig = asyncHandler(async (req: Request, res: Response) => {
  requireUser(req);
  const token = typeof req.query.device_token === "string" ? req.query.device_token : undefined;
  const device = await authenticateDevice(token);
  res.json({
    device_id: device.id,
    event_types: ["IN", "OUT", "BREAK_START", "BREAK_END"],
    heartbeat_interval_seconds: 60,
  });
});
