import { HttpError } from "../../../utils/httpError";
import {
  repoDeleteSchedule,
  repoGetContractById,
  repoGetRuleSetById,
  repoInsertContract,
  repoInsertRuleSet,
  repoInsertSchedule,
  repoListContracts,
  repoListEmployees,
  repoListRuleSets,
  repoListSchedules,
  repoSetContractActive,
  repoSetRuleSetActive,
  repoUpdateContract,
  repoUpdateRuleSet,
  repoUpdateSchedule,
  type ContractInput,
  type RuleSetInput,
  type ScheduleInput,
} from "../repository/temps-deplacements-rules.repository";
import { insertAuditLog, isPgUniqueViolation, withTransaction, type AuditContext } from "../repository/temps-deplacements.repository";
import { isHrPrivileged, type Actor } from "./temps-deplacements-corrections.service";

// Toute l'administration RH est réservée aux rôles privilégiés (RH/Direction/Admin) — anti-IDOR :
// un salarié n'a AUCUN accès à ces endpoints (403), et ne peut pas cibler un autre employé.
function assertPrivileged(actor: Actor): void {
  if (!isHrPrivileged(actor.role)) throw new HttpError(403, "HR_FORBIDDEN", "Administration RH réservée.");
}

async function audit(actor: Actor, ctx: AuditContext, action: string, entityType: string, entityId: string | null, details: Record<string, unknown>) {
  await withTransaction((client) =>
    insertAuditLog(client, ctx, { action, entity_type: entityType, entity_id: entityId, details })
  );
}

// -------------------------------------------------------------- Employés (lecture pickers)
export async function listEmployees(actor: Actor) {
  assertPrivileged(actor);
  return repoListEmployees();
}

// -------------------------------------------------------------- Rule sets
export async function listRuleSets(actor: Actor) {
  assertPrivileged(actor);
  return repoListRuleSets();
}
export async function createRuleSet(actor: Actor, input: RuleSetInput, ctx: AuditContext) {
  assertPrivileged(actor);
  const row = await withTransaction((client) => repoInsertRuleSet(client, input));
  await audit(actor, ctx, "temps-deplacements.rule_set.create", "hr_time_rule_sets", row.id, { name: input.name });
  return row;
}
export async function updateRuleSet(actor: Actor, id: string, input: RuleSetInput, ctx: AuditContext) {
  assertPrivileged(actor);
  const row = await withTransaction((client) => repoUpdateRuleSet(client, id, input));
  if (!row) throw new HttpError(404, "HR_RULE_SET_NOT_FOUND", "Règle introuvable.");
  await audit(actor, ctx, "temps-deplacements.rule_set.update", "hr_time_rule_sets", id, { name: input.name });
  return row;
}
export async function setRuleSetActive(actor: Actor, id: string, active: boolean, ctx: AuditContext) {
  assertPrivileged(actor);
  const row = await withTransaction((client) => repoSetRuleSetActive(client, id, active));
  if (!row) throw new HttpError(404, "HR_RULE_SET_NOT_FOUND", "Règle introuvable.");
  await audit(actor, ctx, "temps-deplacements.rule_set.set_active", "hr_time_rule_sets", id, { active });
  return row;
}

// -------------------------------------------------------------- Contrats
export async function listContracts(actor: Actor, employeeId?: string) {
  assertPrivileged(actor);
  return withTransaction((client) => repoListContracts(client, employeeId));
}
export async function createContract(actor: Actor, input: ContractInput, ctx: AuditContext) {
  assertPrivileged(actor);
  try {
    const row = await withTransaction((client) => repoInsertContract(client, input));
    await audit(actor, ctx, "temps-deplacements.contract.create", "hr_employment_contracts", row.id, {
      employee_id: input.employee_id, contract_type: input.contract_type,
    });
    return row;
  } catch (err) {
    if (isPgUniqueViolation(err)) throw new HttpError(409, "HR_CONTRACT_ACTIVE_EXISTS", "Un contrat actif existe déjà pour cet employé.");
    throw err;
  }
}
export async function updateContract(actor: Actor, id: string, input: ContractInput, ctx: AuditContext) {
  assertPrivileged(actor);
  try {
    const row = await withTransaction((client) => repoUpdateContract(client, id, input));
    if (!row) throw new HttpError(404, "HR_CONTRACT_NOT_FOUND", "Contrat introuvable.");
    await audit(actor, ctx, "temps-deplacements.contract.update", "hr_employment_contracts", id, { contract_type: input.contract_type });
    return row;
  } catch (err) {
    if (isPgUniqueViolation(err)) throw new HttpError(409, "HR_CONTRACT_ACTIVE_EXISTS", "Un contrat actif existe déjà pour cet employé.");
    throw err;
  }
}
export async function setContractActive(actor: Actor, id: string, active: boolean, ctx: AuditContext) {
  assertPrivileged(actor);
  const existing = await repoGetContractById(id);
  if (!existing) throw new HttpError(404, "HR_CONTRACT_NOT_FOUND", "Contrat introuvable.");
  try {
    const row = await withTransaction((client) => repoSetContractActive(client, id, active));
    await audit(actor, ctx, "temps-deplacements.contract.set_active", "hr_employment_contracts", id, { active });
    return row;
  } catch (err) {
    if (isPgUniqueViolation(err)) throw new HttpError(409, "HR_CONTRACT_ACTIVE_EXISTS", "Un contrat actif existe déjà pour cet employé.");
    throw err;
  }
}

// -------------------------------------------------------------- Horaires types
export async function listSchedules(actor: Actor, employeeId: string) {
  assertPrivileged(actor);
  return withTransaction((client) => repoListSchedules(client, employeeId));
}
export async function createSchedule(actor: Actor, input: ScheduleInput, ctx: AuditContext) {
  assertPrivileged(actor);
  const row = await withTransaction((client) => repoInsertSchedule(client, input));
  await audit(actor, ctx, "temps-deplacements.schedule.create", "hr_work_schedules", row.id, { employee_id: input.employee_id, day_of_week: input.day_of_week });
  return row;
}
export async function updateSchedule(actor: Actor, id: string, input: ScheduleInput, ctx: AuditContext) {
  assertPrivileged(actor);
  const row = await withTransaction((client) => repoUpdateSchedule(client, id, input));
  if (!row) throw new HttpError(404, "HR_SCHEDULE_NOT_FOUND", "Horaire introuvable.");
  await audit(actor, ctx, "temps-deplacements.schedule.update", "hr_work_schedules", id, { day_of_week: input.day_of_week });
  return row;
}
export async function deleteSchedule(actor: Actor, id: string, ctx: AuditContext) {
  assertPrivileged(actor);
  const ok = await withTransaction((client) => repoDeleteSchedule(client, id));
  if (!ok) throw new HttpError(404, "HR_SCHEDULE_NOT_FOUND", "Horaire introuvable.");
  await audit(actor, ctx, "temps-deplacements.schedule.delete", "hr_work_schedules", id, {});
  return { ok: true };
}
