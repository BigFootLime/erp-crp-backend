import { HttpError } from "../../../utils/httpError";
import { assertPeriodOpen, isHrPrivileged, type HrActor as Actor } from "../domain/temps-deplacements-policy";
import {
  insertAuditLog,
  repoGetEmployeeById,
  withTransaction,
  type AuditContext,
} from "../repository/temps-deplacements.repository";
import {
  repoCreateAbsence,
  repoCreateKilometerRate,
  repoCreatePeriodClosure,
  repoDecideAbsence,
  repoGetAbsence,
  repoGetClosurePreflight,
  repoGetCurrentKilometerRate,
  repoGetPeriodClosure,
  repoGetTeamOperationsQueue,
  repoListAbsences,
  repoListKilometerRates,
  repoListPeriodClosures,
  repoReopenPeriodClosure,
} from "../repository/temps-deplacements-operations.repository";
import type {
  CreateAbsenceBody,
  CreateKilometerRateBody,
  CreatePeriodClosureBody,
} from "../validators/temps-deplacements.validators";
import { resolveEmployeeFromUser } from "./temps-deplacements.service";

async function assertCanManageEmployee(actor: Actor, employeeId: string): Promise<void> {
  if (isHrPrivileged(actor.role)) return;
  const employee = await repoGetEmployeeById(employeeId);
  if (employee?.manager_user_id === actor.id) return;
  throw new HttpError(403, "HR_FORBIDDEN", "Hors de votre périmètre de gestion.");
}

function assertPrivileged(actor: Actor): void {
  if (!isHrPrivileged(actor.role)) throw new HttpError(403, "HR_ADMIN_REQUIRED", "Action réservée à l'administration RH.");
}

export async function createMyAbsence(actor: Actor, input: CreateAbsenceBody, audit: AuditContext) {
  const employee = await resolveEmployeeFromUser(actor.id);
  await assertPeriodOpen(employee.id, input.absence_date);
  try {
    return await withTransaction(async (tx) => {
      const row = await repoCreateAbsence(tx, {
        employee_id: employee.id, absence_date: input.absence_date, minutes: input.minutes,
        absence_type: input.absence_type, timezone: input.timezone, reason: input.reason,
        source_ref: input.source_ref ?? null, requested_by: actor.id,
      });
      await insertAuditLog(tx, audit, {
        action: "temps-deplacements.absence.request", entity_type: "hr_absence_records", entity_id: row.id,
        details: { absence_date: row.absence_date, minutes: row.minutes, absence_type: row.absence_type },
      });
      return row;
    });
  } catch (error) {
    if ((error as { code?: string }).code === "23505") {
      throw new HttpError(409, "HR_ABSENCE_DUPLICATE", "Une absence active du même type existe déjà pour cette date.");
    }
    throw error;
  }
}

export async function listMyAbsences(actor: Actor) {
  const employee = await resolveEmployeeFromUser(actor.id);
  return repoListAbsences({ employee_id: employee.id });
}

export async function listTeamAbsences(actor: Actor, status?: "REQUESTED" | "APPROVED" | "REJECTED" | "CANCELLED") {
  return repoListAbsences({ manager_user_id: actor.id, privileged: isHrPrivileged(actor.role), status });
}

export async function decideAbsence(
  actor: Actor,
  id: string,
  decision: "APPROVED" | "REJECTED",
  audit: AuditContext,
) {
  const absence = await repoGetAbsence(id);
  if (!absence) throw new HttpError(404, "HR_ABSENCE_NOT_FOUND", "Absence introuvable.");
  if (absence.requested_by === actor.id) throw new HttpError(403, "HR_SELF_APPROVAL_FORBIDDEN", "Auto-validation d'une absence interdite.");
  await assertCanManageEmployee(actor, absence.employee_id);
  await assertPeriodOpen(absence.employee_id, absence.absence_date);
  return withTransaction(async (tx) => {
    const updated = await repoDecideAbsence(tx, id, decision, actor.id);
    if (!updated) throw new HttpError(409, "HR_ABSENCE_NOT_PENDING", "Absence déjà traitée.");
    await insertAuditLog(tx, audit, {
      action: decision === "APPROVED" ? "temps-deplacements.absence.approve" : "temps-deplacements.absence.reject",
      entity_type: "hr_absence_records", entity_id: id,
      details: { decision, absence_date: absence.absence_date, employee_id: absence.employee_id },
    });
    return updated;
  });
}

export async function createPeriodClosure(actor: Actor, input: CreatePeriodClosureBody, audit: AuditContext) {
  assertPrivileged(actor);
  const normalized = { ...input, employee_id: input.employee_id ?? null };
  const preflight = await repoGetClosurePreflight(normalized);
  const blockerCount = Object.values(preflight).reduce((sum, value) => sum + value, 0);
  if (blockerCount > 0) {
    throw new HttpError(409, "HR_PERIOD_PREFLIGHT_FAILED", `Clôture refusée : ${blockerCount} élément(s) restent à traiter.`, preflight);
  }
  try {
    return await withTransaction(async (tx) => {
      const closure = await repoCreatePeriodClosure(tx, { ...normalized, closed_by: actor.id });
      await insertAuditLog(tx, audit, {
        action: "temps-deplacements.period.close", entity_type: "hr_period_closures", entity_id: closure.id,
        details: { period_start: closure.period_start, period_end: closure.period_end, employee_id: closure.employee_id, timezone: closure.timezone },
      });
      return { closure, preflight };
    });
  } catch (error) {
    if ((error as { code?: string }).code === "HR_PERIOD_OVERLAP") {
      throw new HttpError(409, "HR_PERIOD_OVERLAP", "Une clôture active chevauche déjà cette période.");
    }
    throw error;
  }
}

export async function reopenPeriodClosure(actor: Actor, id: string, audit: AuditContext) {
  assertPrivileged(actor);
  const before = await repoGetPeriodClosure(id);
  if (!before) throw new HttpError(404, "HR_PERIOD_NOT_FOUND", "Période clôturée introuvable.");
  return withTransaction(async (tx) => {
    const reopened = await repoReopenPeriodClosure(tx, id, actor.id);
    if (!reopened) throw new HttpError(409, "HR_PERIOD_ALREADY_REOPENED", "Cette période est déjà rouverte.");
    await insertAuditLog(tx, audit, {
      action: "temps-deplacements.period.reopen", entity_type: "hr_period_closures", entity_id: id,
      details: { period_start: before.period_start, period_end: before.period_end, employee_id: before.employee_id },
    });
    return reopened;
  });
}

export async function listClosures(actor: Actor) {
  assertPrivileged(actor);
  return repoListPeriodClosures();
}

export async function createKilometerRate(actor: Actor, input: CreateKilometerRateBody, audit: AuditContext) {
  assertPrivileged(actor);
  return withTransaction(async (tx) => {
    const current = await repoGetCurrentKilometerRate(input.owner_type, tx);
    if (current && input.effective_from <= current.effective_from) {
      throw new HttpError(409, "HR_KM_RATE_DATE_INVALID", "La nouvelle version doit commencer après le taux courant.");
    }
    const created = await repoCreateKilometerRate(tx, {
      ...input, source_ref: input.source_ref ?? null, supersedes_id: current?.id ?? null, created_by: actor.id,
    });
    await insertAuditLog(tx, audit, {
      action: "temps-deplacements.km-rate.version.create", entity_type: "hr_kilometer_rate_versions", entity_id: created.id,
      details: { owner_type: created.owner_type, effective_from: created.effective_from, currency: created.currency, supersedes_id: created.supersedes_id },
    });
    return created;
  });
}

export async function listKilometerRates(actor: Actor) {
  assertPrivileged(actor);
  return repoListKilometerRates();
}

export async function getOperationsQueue(actor: Actor) {
  return repoGetTeamOperationsQueue({ manager_user_id: actor.id, privileged: isHrPrivileged(actor.role) });
}
