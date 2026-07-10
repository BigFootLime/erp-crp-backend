import { HttpError } from "../../../utils/httpError";
import {
  repoCreateKmEntry,
  repoCreateVehicle,
  repoDecideKmEntry,
  repoGetKmEntryById,
  repoListKmForEmployee,
  repoListTeamKmEntries,
  repoListVehicles,
  repoSubmitKmEntry,
  type HrKmStatus,
  type HrKmType,
  type KmEntry,
} from "../repository/temps-deplacements-km.repository";
import { insertAuditLog, repoGetEmployeeById, withTransaction, type AuditContext } from "../repository/temps-deplacements.repository";
import { isHrPrivileged, type Actor } from "./temps-deplacements-corrections.service";
import { resolveEmployeeFromUser } from "./temps-deplacements.service";

async function assertCanManageEmployee(actor: Actor, employeeId: string): Promise<void> {
  if (isHrPrivileged(actor.role)) return;
  const emp = await repoGetEmployeeById(employeeId);
  if (emp && emp.manager_user_id !== null && emp.manager_user_id === actor.id) return;
  throw new HttpError(403, "HR_FORBIDDEN", "Hors de votre périmètre de gestion.");
}

// Distance : privilégie l'écart de compteur (odomètre) s'il est fourni, sinon la distance saisie.
export function computeDistanceKm(input: { start_odometer: number | null; end_odometer: number | null; distance_km: number }): number {
  if (input.start_odometer != null && input.end_odometer != null) {
    return Math.max(0, Number((input.end_odometer - input.start_odometer).toFixed(2)));
  }
  return Math.max(0, Number((input.distance_km ?? 0).toFixed(2)));
}

export interface CreateKmInput {
  date: string;
  type: HrKmType;
  vehicle_id: string | null;
  start_location: string | null;
  end_location: string | null;
  start_odometer: number | null;
  end_odometer: number | null;
  distance_km: number;
  affaire_id: number | null;
  client_id: number | null;
  fournisseur_id: number | null;
  submit: boolean;
}

// ANTI-IDOR : l'employé vient de req.user, JAMAIS du corps. Le salarié déclare SES kilomètres.
export async function createMyKmEntry(actor: Actor, input: CreateKmInput, audit: AuditContext): Promise<KmEntry> {
  const emp = await resolveEmployeeFromUser(actor.id);
  const distance = computeDistanceKm(input);
  return withTransaction(async (client) => {
    const entry = await repoCreateKmEntry(client, {
      employee_id: emp.id,
      date: input.date,
      type: input.type,
      vehicle_id: input.vehicle_id,
      start_location: input.start_location,
      end_location: input.end_location,
      start_odometer: input.start_odometer,
      end_odometer: input.end_odometer,
      distance_km: distance,
      affaire_id: input.affaire_id,
      client_id: input.client_id,
      fournisseur_id: input.fournisseur_id,
      status: input.submit ? "SUBMITTED" : "DRAFT",
    });
    await insertAuditLog(client, audit, {
      action: "temps-deplacements.km.create",
      entity_type: "hr_kilometer_entries",
      entity_id: entry.id,
      details: { type: input.type, distance_km: distance, status: entry.status },
    });
    return entry;
  });
}

export async function listMyKmEntries(actor: Actor, filters: { from?: string; to?: string; status?: HrKmStatus }): Promise<KmEntry[]> {
  const emp = await resolveEmployeeFromUser(actor.id);
  return repoListKmForEmployee(emp.id, filters);
}

export async function submitMyKmEntry(actor: Actor, id: string, audit: AuditContext): Promise<KmEntry> {
  const entry = await repoGetKmEntryById(id);
  if (!entry) throw new HttpError(404, "HR_KM_NOT_FOUND", "Déclaration introuvable.");
  const emp = await resolveEmployeeFromUser(actor.id);
  if (entry.employee_id !== emp.id) throw new HttpError(403, "HR_FORBIDDEN", "Vous ne pouvez soumettre que vos déclarations.");
  return withTransaction(async (client) => {
    const updated = await repoSubmitKmEntry(client, id);
    if (!updated) throw new HttpError(409, "HR_KM_NOT_DRAFT", "Déclaration déjà soumise ou traitée.");
    await insertAuditLog(client, audit, { action: "temps-deplacements.km.submit", entity_type: "hr_kilometer_entries", entity_id: id, details: { status: "SUBMITTED" } });
    return updated;
  });
}

export async function decideKmEntry(actor: Actor, id: string, decision: "VALIDATED" | "REJECTED", audit: AuditContext): Promise<KmEntry> {
  const entry = await repoGetKmEntryById(id);
  if (!entry) throw new HttpError(404, "HR_KM_NOT_FOUND", "Déclaration introuvable.");
  await assertCanManageEmployee(actor, entry.employee_id);
  return withTransaction(async (client) => {
    const updated = await repoDecideKmEntry(client, id, decision, actor.id);
    if (!updated) throw new HttpError(409, "HR_KM_NOT_SUBMITTED", "La déclaration doit être soumise pour être traitée.");
    await insertAuditLog(client, audit, {
      action: decision === "VALIDATED" ? "temps-deplacements.km.validate" : "temps-deplacements.km.reject",
      entity_type: "hr_kilometer_entries",
      entity_id: id,
      details: { decision },
    });
    return updated;
  });
}

export async function listTeamKmEntries(actor: Actor, status?: HrKmStatus) {
  return repoListTeamKmEntries({ managerUserId: actor.id, isPrivileged: isHrPrivileged(actor.role), status });
}

export async function listVehicles() {
  return repoListVehicles();
}
export async function createVehicle(actor: Actor, input: { label: string; plate: string | null; owner_type: "COMPANY" | "PERSONAL" }, audit: AuditContext) {
  if (!isHrPrivileged(actor.role)) throw new HttpError(403, "HR_FORBIDDEN", "Gestion des véhicules réservée.");
  return withTransaction(async (client) => {
    const v = await repoCreateVehicle(client, input);
    await insertAuditLog(client, audit, { action: "temps-deplacements.vehicle.create", entity_type: "hr_vehicles", entity_id: v.id, details: { label: input.label } });
    return v;
  });
}
