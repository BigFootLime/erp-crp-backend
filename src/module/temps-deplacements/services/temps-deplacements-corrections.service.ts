import { HttpError } from "../../../utils/httpError";
import { assertPeriodOpen, isHrPrivileged, type HrActor } from "../domain/temps-deplacements-policy";
import {
  repoCreateAdjustment,
  repoDecideAdjustment,
  repoGetAdjustmentById,
  repoGetTimesheetDayById,
  repoGetTimesheetWeekById,
  repoListTeamAdjustments,
  repoListTeamAnomaliesForDate,
  repoListTeamEmployees,
  repoResolveTargetEmployeeId,
  repoSetDayValidation,
  repoSetWeekValidation,
  type HrAdjustment,
  type HrAdjustmentWithEmployee,
  type TimesheetRef,
} from "../repository/temps-deplacements-corrections.repository";
import {
  insertAuditLog,
  repoGetEmployeeById,
  withTransaction,
  type AuditContext,
} from "../repository/temps-deplacements.repository";
import type { CreateAdjustmentBody } from "../validators/temps-deplacements.validators";
import { repoResolveAdjustmentPeriod } from "../repository/temps-deplacements-operations.repository";
import { computeDailyTimesheet, todayParis } from "./temps-deplacements.service";
export type Actor = HrActor;

// Miroir de isHrPrivileged du contrôleur T2 (rôle RH/Direction/Admin). Pur ⇒ testable directement.
export { isHrPrivileged };

// Lève 403 si l'appelant n'est ni le manager de l'employé ni un rôle privilégié (anti-IDOR périmètre).
async function assertCanManageEmployee(actor: Actor, employeeId: string): Promise<void> {
  if (isHrPrivileged(actor.role)) return;
  const emp = await repoGetEmployeeById(employeeId);
  if (emp && emp.manager_user_id !== null && emp.manager_user_id === actor.id) return;
  throw new HttpError(403, "HR_FORBIDDEN", "Hors de votre périmètre de gestion.");
}

// -------------------------------------------------------------- Corrections (tracées, motif obligatoire)
// Le salarié demande une correction sur SES données (ou son manager / RH sur le périmètre). L'application
// numérique d'une correction approuvée (override dans le relevé) relève de T5 : ici on trace la DÉCISION
// (append-only events ⇒ jamais mutés). L'enregistrement approuvé est la preuve légale de la correction.
export async function createAdjustment(
  actor: Actor,
  body: CreateAdjustmentBody,
  audit: AuditContext
): Promise<HrAdjustment> {
  const targetEmployeeId = await repoResolveTargetEmployeeId(body.target_type, body.target_id);
  if (!targetEmployeeId) throw new HttpError(404, "HR_TARGET_NOT_FOUND", "Cible de correction introuvable.");
  const targetPeriod = await repoResolveAdjustmentPeriod(body.target_type, body.target_id);
  if (!targetPeriod) throw new HttpError(404, "HR_TARGET_NOT_FOUND", "Période de correction introuvable.");
  await assertPeriodOpen(targetPeriod.employee_id, targetPeriod.from, targetPeriod.to);

  const emp = await repoGetEmployeeById(targetEmployeeId);
  const isSelf = emp?.user_id === actor.id;
  const isManager = emp?.manager_user_id !== null && emp?.manager_user_id === actor.id;
  if (!isSelf && !isManager && !isHrPrivileged(actor.role)) {
    throw new HttpError(403, "HR_FORBIDDEN", "Vous ne pouvez demander une correction que sur vos données.");
  }

  return withTransaction(async (client) => {
    const adj = await repoCreateAdjustment(client, {
      target_type: body.target_type,
      target_id: body.target_id,
      reason: body.reason,
      old_value: body.old_value ?? null,
      new_value: body.new_value ?? null,
      requested_by: actor.id,
    });
    await insertAuditLog(client, audit, {
      action: "temps-deplacements.adjustment.requested",
      entity_type: "hr_time_adjustments",
      entity_id: adj.id,
      details: { target_type: body.target_type, target_id: body.target_id, reason: body.reason },
    });
    return adj;
  });
}

// Approuve / rejette une demande. INTERDIT : auto-validation (requested_by === actor). RBAC périmètre.
export async function decideAdjustment(
  actor: Actor,
  id: string,
  decision: "APPROVED" | "REJECTED",
  audit: AuditContext
): Promise<HrAdjustment> {
  const adj = await repoGetAdjustmentById(id);
  if (!adj) throw new HttpError(404, "HR_ADJUSTMENT_NOT_FOUND", "Demande de correction introuvable.");
  if (adj.status !== "REQUESTED") throw new HttpError(409, "HR_ADJUSTMENT_NOT_PENDING", "Demande déjà traitée.");
  if (adj.requested_by === actor.id) {
    throw new HttpError(403, "HR_SELF_APPROVAL_FORBIDDEN", "Auto-validation d'une correction interdite.");
  }
  const targetEmployeeId = await repoResolveTargetEmployeeId(adj.target_type, adj.target_id);
  if (!targetEmployeeId) throw new HttpError(404, "HR_TARGET_NOT_FOUND", "Cible de correction introuvable.");
  const targetPeriod = await repoResolveAdjustmentPeriod(adj.target_type, adj.target_id);
  if (!targetPeriod) throw new HttpError(404, "HR_TARGET_NOT_FOUND", "Période de correction introuvable.");
  await assertPeriodOpen(targetPeriod.employee_id, targetPeriod.from, targetPeriod.to);
  await assertCanManageEmployee(actor, targetEmployeeId);

  return withTransaction(async (client) => {
    const updated = await repoDecideAdjustment(client, id, decision, actor.id);
    if (!updated) throw new HttpError(409, "HR_ADJUSTMENT_NOT_PENDING", "Demande déjà traitée.");
    await insertAuditLog(client, audit, {
      action: decision === "APPROVED" ? "temps-deplacements.adjustment.approved" : "temps-deplacements.adjustment.rejected",
      entity_type: "hr_time_adjustments",
      entity_id: id,
      details: { decision, target_type: adj.target_type, target_id: adj.target_id },
    });
    return updated;
  });
}

export async function listTeamAdjustments(actor: Actor): Promise<HrAdjustmentWithEmployee[]> {
  return repoListTeamAdjustments({ managerUserId: actor.id, isPrivileged: isHrPrivileged(actor.role) });
}

// -------------------------------------------------------------- Validation jour / semaine
export async function validateTimesheetDay(actor: Actor, dayId: string, audit: AuditContext): Promise<TimesheetRef> {
  const day = await repoGetTimesheetDayById(dayId);
  if (!day) throw new HttpError(404, "HR_TIMESHEET_NOT_FOUND", "Journée introuvable.");
  const employee = await repoGetEmployeeById(day.employee_id);
  if (employee?.user_id === actor.id) {
    throw new HttpError(403, "HR_SELF_APPROVAL_FORBIDDEN", "Auto-validation de sa propre journée interdite.");
  }
  await assertCanManageEmployee(actor, day.employee_id);
  const targetPeriod = await repoResolveAdjustmentPeriod("DAY", dayId);
  if (!targetPeriod) throw new HttpError(404, "HR_TIMESHEET_NOT_FOUND", "Journée introuvable.");
  await assertPeriodOpen(day.employee_id, targetPeriod.from, targetPeriod.to);
  if (day.validation_status === "VALIDATED" || day.validation_status === "EXPORTED") {
    throw new HttpError(409, "HR_ALREADY_VALIDATED", "Journée déjà validée ou exportée.");
  }
  return withTransaction(async (client) => {
    const updated = await repoSetDayValidation(client, dayId, "VALIDATED", actor.id);
    if (!updated) throw new HttpError(409, "HR_ALREADY_VALIDATED", "Journée déjà validée ou exportée.");
    await insertAuditLog(client, audit, {
      action: "temps-deplacements.day.validated",
      entity_type: "hr_timesheet_days",
      entity_id: dayId,
      details: { validation_status: "VALIDATED" },
    });
    return updated;
  });
}

export async function validateTimesheetWeek(actor: Actor, weekId: string, audit: AuditContext): Promise<TimesheetRef> {
  const week = await repoGetTimesheetWeekById(weekId);
  if (!week) throw new HttpError(404, "HR_TIMESHEET_NOT_FOUND", "Semaine introuvable.");
  const employee = await repoGetEmployeeById(week.employee_id);
  if (employee?.user_id === actor.id) {
    throw new HttpError(403, "HR_SELF_APPROVAL_FORBIDDEN", "Auto-validation de sa propre semaine interdite.");
  }
  await assertCanManageEmployee(actor, week.employee_id);
  const targetPeriod = await repoResolveAdjustmentPeriod("WEEK", weekId);
  if (!targetPeriod) throw new HttpError(404, "HR_TIMESHEET_NOT_FOUND", "Semaine introuvable.");
  await assertPeriodOpen(week.employee_id, targetPeriod.from, targetPeriod.to);
  if (week.validation_status === "VALIDATED" || week.validation_status === "EXPORTED") {
    throw new HttpError(409, "HR_ALREADY_VALIDATED", "Semaine déjà validée ou exportée.");
  }
  return withTransaction(async (client) => {
    const updated = await repoSetWeekValidation(client, weekId, "VALIDATED", actor.id);
    if (!updated) throw new HttpError(409, "HR_ALREADY_VALIDATED", "Semaine déjà validée ou exportée.");
    await insertAuditLog(client, audit, {
      action: "temps-deplacements.week.validated",
      entity_type: "hr_timesheet_weeks",
      entity_id: weekId,
      details: { validation_status: "VALIDATED" },
    });
    return updated;
  });
}

// -------------------------------------------------------------- Périmètre équipe (lecture)
export async function teamToday(actor: Actor): Promise<{
  date: string;
  employees: Array<{ employee: { id: string; matricule: string; service: string | null }; timesheet: Awaited<ReturnType<typeof computeDailyTimesheet>> }>;
}> {
  const isPriv = isHrPrivileged(actor.role);
  const employees = await repoListTeamEmployees({ managerUserId: actor.id, isPrivileged: isPriv });
  const date = todayParis();
  const rows = await Promise.all(
    employees.map(async (e) => ({
      employee: { id: e.id, matricule: e.matricule, service: e.service },
      timesheet: await computeDailyTimesheet(e.id, date),
    }))
  );
  return { date, employees: rows };
}

export async function teamAnomalies(actor: Actor, date?: string) {
  const isPriv = isHrPrivileged(actor.role);
  const d = date ?? todayParis();
  const anomalies = await repoListTeamAnomaliesForDate({ managerUserId: actor.id, isPrivileged: isPriv, date: d });
  return { date: d, anomalies };
}
