import crypto from "node:crypto";
import { HttpError } from "../../../utils/httpError";
import * as repo from "../repository/temps-deplacements.repository";
import type { AuditContext } from "../repository/temps-deplacements.repository";
import type {
  CreateTimeEventInput,
  CreateTimeEventResult,
  HrDailyTimesheet,
  HrEmployeeLite,
  HrTimeAnomaly,
  HrTimeEvent,
  HrWeeklyTimesheet,
} from "../types/temps-deplacements.types";

// Seuils d'anomalie = défauts MVP (déplaçables dans hr_time_rule_sets en T5).
// L'attendu contractuel (35h/39h) vient DÉJÀ de la base (repoGetDailyTargetMinutes) — jamais en dur.
const DOUBLE_BADGE_WINDOW_MS = 90_000;
const TOO_LONG_DAY_MINUTES = 12 * 60;
const LONG_DAY_MINUTES = 6 * 60;
const MIN_BREAK_MINUTES = 20;
const TZ = "Europe/Paris";

export function hashBadgeUid(uid: string): string {
  return crypto.createHash("sha256").update(uid.trim()).digest("hex");
}
export function hashDeviceToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function parisDay(iso: string | number | Date): string {
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: TZ }); // en-CA => YYYY-MM-DD
}
export function todayParis(): string {
  return parisDay(Date.now());
}
function addDays(ymd: string, n: number): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// -------------------------------------------------------------- Résolution employé
export async function resolveEmployeeFromUser(userId: number): Promise<HrEmployeeLite> {
  const emp = await repo.repoGetEmployeeByUserId(userId);
  if (!emp) throw new HttpError(404, "HR_EMPLOYEE_NOT_FOUND", "Aucun employé n'est lié à ce compte.");
  if (emp.status !== "ACTIVE") throw new HttpError(403, "HR_EMPLOYEE_INACTIVE", "Employé inactif.");
  return emp;
}

export async function resolveEmployeeFromBadge(badgeUid: string): Promise<HrEmployeeLite> {
  const found = await repo.repoFindBadge(hashBadgeUid(badgeUid));
  if (!found) throw new HttpError(404, "HR_BADGE_UNKNOWN", "Badge inconnu.");
  if (!found.active) throw new HttpError(403, "HR_BADGE_REVOKED", "Badge révoqué.");
  if (found.employee.status !== "ACTIVE") throw new HttpError(403, "HR_EMPLOYEE_INACTIVE", "Employé inactif.");
  return found.employee;
}

// -------------------------------------------------------------- Création d'événement (append-only)
export async function createTimeEvent(input: CreateTimeEventInput, audit: AuditContext): Promise<CreateTimeEventResult> {
  const result = await repo.withTransaction(async (client) => {
    const evtTimeMs = input.event_time ? new Date(input.event_time).getTime() : Date.now();

    // Double badge rapproché (même type, < fenêtre) — hors retry idempotent explicite.
    if (!input.idempotency_key) {
      const last = await repo.repoGetLastEvent(input.employee_id, client);
      if (last && last.event_type === input.event_type) {
        const delta = Math.abs(evtTimeMs - new Date(last.event_time).getTime());
        if (delta < DOUBLE_BADGE_WINDOW_MS) {
          await repo.repoInsertAnomaly(client, {
            employee_id: input.employee_id,
            date: parisDay(last.event_time),
            anomaly_type: "DOUBLE_BADGE",
            severity: "WARNING",
            message: `Double badge ${input.event_type} rapproché ignoré`,
          });
          await repo.insertAuditLog(client, audit, {
            action: input.source === "BADGE" ? "temps-deplacements.event.double_badge_badge" : "temps-deplacements.event.double_badge_web",
            entity_type: "hr_time_events",
            entity_id: last.id,
            details: { event_type: input.event_type, source: input.source },
          });
          return { event: last, deduplicated: true, double_badge: true };
        }
      }
    }

    const inserted = await repo.repoInsertTimeEvent(client, input);
    await repo.insertAuditLog(client, audit, {
      action: input.source === "BADGE" ? "temps-deplacements.event.create_badge" : "temps-deplacements.event.create_web",
      entity_type: "hr_time_events",
      entity_id: inserted.event.id,
      // JAMAIS de badge_uid/token/payload sensible dans l'audit.
      details: { event_type: input.event_type, source: input.source, deduplicated: inserted.deduplicated },
    });
    return { event: inserted.event, deduplicated: inserted.deduplicated, double_badge: false };
  });

  // Recalcul du jour (best-effort ; ne doit jamais faire échouer l'enregistrement de l'événement).
  try {
    await computeDailyTimesheet(input.employee_id, parisDay(result.event.event_time));
  } catch {
    /* noop */
  }
  return result;
}

// -------------------------------------------------------------- Détection d'anomalies (pure)
export function detectTimeAnomalies(
  events: HrTimeEvent[],
  ctx: { openBreak: boolean; workedMinutes: number; totalBreak: number; isPastDay: boolean }
): Array<{ anomaly_type: HrTimeAnomaly["anomaly_type"]; severity: HrTimeAnomaly["severity"]; message: string }> {
  const out: Array<{ anomaly_type: HrTimeAnomaly["anomaly_type"]; severity: HrTimeAnomaly["severity"]; message: string }> = [];
  const hasIn = events.some((e) => e.event_type === "IN");
  const hasOut = events.some((e) => e.event_type === "OUT");
  if (hasOut && !hasIn) out.push({ anomaly_type: "MISSING_IN", severity: "WARNING", message: "Sortie sans entrée" });
  // MISSING_OUT / MISSING_BREAK_END : uniquement sur un jour passé (aujourd'hui, une session ouverte est normale).
  if (ctx.isPastDay && hasIn && !hasOut) out.push({ anomaly_type: "MISSING_OUT", severity: "WARNING", message: "Entrée sans sortie" });
  if (ctx.isPastDay && ctx.openBreak) out.push({ anomaly_type: "MISSING_BREAK_END", severity: "WARNING", message: "Pause non terminée" });
  if (ctx.workedMinutes > TOO_LONG_DAY_MINUTES) out.push({ anomaly_type: "TOO_LONG_DAY", severity: "WARNING", message: "Journée trop longue" });
  if (ctx.workedMinutes >= LONG_DAY_MINUTES && ctx.totalBreak > 0 && ctx.totalBreak < MIN_BREAK_MINUTES) {
    out.push({ anomaly_type: "TOO_SHORT_BREAK", severity: "INFO", message: "Pause trop courte" });
  }
  return out;
}

// Résumé PUR d'une journée à partir des événements bruts triés (testable sans DB).
export function summarizeDay(events: HrTimeEvent[]): {
  firstIn: string | null;
  lastOut: string | null;
  breakMinutes: number;
  workedMinutes: number;
  openBreak: boolean;
} {
  let firstIn: string | null = null;
  let lastOut: string | null = null;
  let totalBreak = 0;
  let openBreakStart: number | null = null;
  for (const e of events) {
    const t = new Date(e.event_time).getTime();
    switch (e.event_type) {
      case "IN":
        if (firstIn === null) firstIn = e.event_time;
        break;
      case "OUT":
        lastOut = e.event_time;
        break;
      case "BREAK_START":
        openBreakStart = t;
        break;
      case "BREAK_END":
        if (openBreakStart !== null) {
          totalBreak += Math.max(0, Math.round((t - openBreakStart) / 60000));
          openBreakStart = null;
        }
        break;
      default:
        break; // MISSION_* : hors calcul de présence en T2 (traité en T6)
    }
  }
  const openBreak = openBreakStart !== null;
  const workedMinutes =
    firstIn && lastOut
      ? Math.max(0, Math.round((new Date(lastOut).getTime() - new Date(firstIn).getTime()) / 60000) - totalBreak)
      : 0;
  return { firstIn, lastOut, breakMinutes: totalBreak, workedMinutes, openBreak };
}

// -------------------------------------------------------------- Relevé journalier
export async function computeDailyTimesheet(employeeId: string, date: string): Promise<HrDailyTimesheet> {
  const events = await repo.repoListEventsForDay(employeeId, date);
  const { firstIn, lastOut, breakMinutes: totalBreak, workedMinutes, openBreak } = summarizeDay(events);

  const expected = await repo.repoGetDailyTargetMinutes(employeeId, date);
  const overtime = Math.max(0, workedMinutes - expected);
  const missing = Math.max(0, expected - workedMinutes);
  const isPastDay = date < todayParis();

  const descriptors = detectTimeAnomalies(events, { openBreak, workedMinutes, totalBreak, isPastDay });

  await repo.withTransaction(async (client) => {
    await repo.repoRefreshDayAnomalies(client, employeeId, date, descriptors);
    await repo.repoUpsertTimesheetDay(client, {
      employee_id: employeeId,
      date,
      expected_minutes: expected,
      worked_minutes: workedMinutes,
      overtime_minutes: overtime,
      missing_minutes: missing,
      anomaly_count: descriptors.length,
    });
  });

  const anomalies = await repo.repoListAnomalies(employeeId, { date });
  const status: HrDailyTimesheet["status"] = anomalies.some((a) => a.resolved_at === null) ? "ANOMALY" : "OK";
  return {
    employee_id: employeeId,
    date,
    first_in: firstIn,
    last_out: lastOut,
    break_minutes: totalBreak,
    worked_minutes: workedMinutes,
    expected_minutes: expected,
    overtime_minutes: overtime,
    missing_minutes: missing,
    status,
    anomalies,
  };
}

// -------------------------------------------------------------- Relevé hebdomadaire
export async function computeWeeklyTimesheet(employeeId: string, weekStart: string): Promise<HrWeeklyTimesheet> {
  const days: HrDailyTimesheet[] = [];
  for (let i = 0; i < 7; i++) {
    days.push(await computeDailyTimesheet(employeeId, addDays(weekStart, i)));
  }
  const worked = days.reduce((s, d) => s + d.worked_minutes, 0);
  const expected = days.reduce((s, d) => s + d.expected_minutes, 0);
  return {
    employee_id: employeeId,
    week_start: weekStart,
    week_end: addDays(weekStart, 6),
    worked_minutes: worked,
    contract_minutes: expected,
    overtime_minutes: Math.max(0, worked - expected),
    absence_minutes: Math.max(0, expected - worked),
    days,
  };
}

export async function listMyAnomalies(employeeId: string, filters: { date?: string; from?: string; to?: string }): Promise<HrTimeAnomaly[]> {
  return repo.repoListAnomalies(employeeId, filters);
}
