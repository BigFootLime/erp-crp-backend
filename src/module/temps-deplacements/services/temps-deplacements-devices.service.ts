import crypto from "node:crypto";
import { HttpError } from "../../../utils/httpError";
import {
  repoCreateBadge,
  repoCreateDevice,
  repoListBadges,
  repoListDevices,
  repoRevokeBadge,
  repoRotateDeviceToken,
  repoSetDeviceStatus,
  type HrDeviceStatus,
} from "../repository/temps-deplacements-devices.repository";
import { insertAuditLog, repoGetEmployeeById, withTransaction, type AuditContext } from "../repository/temps-deplacements.repository";
import { isHrPrivileged, type Actor } from "./temps-deplacements-corrections.service";
import { hashBadgeUid, hashDeviceToken } from "./temps-deplacements.service";

function assertPrivileged(actor: Actor): void {
  if (!isHrPrivileged(actor.role)) throw new HttpError(403, "HR_FORBIDDEN", "Gestion des bornes/badges réservée.");
}

// Token opaque, imprévisible. Stocké HACHÉ ; renvoyé en clair UNE seule fois (pour configurer la borne).
function generateDeviceToken(): string {
  return crypto.randomBytes(24).toString("hex");
}

// -------------------------------------------------------------- Bornes
export async function createDevice(actor: Actor, input: { name: string; location: string | null; device_type: string | null }, audit: AuditContext) {
  assertPrivileged(actor);
  const token = generateDeviceToken();
  const device = await withTransaction(async (client) => {
    const row = await repoCreateDevice(client, { name: input.name, location: input.location, device_type: input.device_type, device_token_hash: hashDeviceToken(token) });
    await insertAuditLog(client, audit, { action: "temps-deplacements.device.create", entity_type: "hr_time_clock_devices", entity_id: row.id, details: { name: input.name } });
    return row;
  });
  return { device, token }; // token en clair : à copier maintenant, non re-consultable
}

export async function listDevices(actor: Actor) {
  assertPrivileged(actor);
  return repoListDevices();
}

export async function setDeviceStatus(actor: Actor, id: string, status: HrDeviceStatus, audit: AuditContext) {
  assertPrivileged(actor);
  const row = await withTransaction(async (client) => {
    const d = await repoSetDeviceStatus(client, id, status);
    if (!d) return null;
    await insertAuditLog(client, audit, { action: "temps-deplacements.device.set_status", entity_type: "hr_time_clock_devices", entity_id: id, details: { status } });
    return d;
  });
  if (!row) throw new HttpError(404, "HR_DEVICE_NOT_FOUND", "Borne introuvable.");
  return row;
}

export async function rotateDeviceToken(actor: Actor, id: string, audit: AuditContext) {
  assertPrivileged(actor);
  const token = generateDeviceToken();
  const device = await withTransaction(async (client) => {
    const d = await repoRotateDeviceToken(client, id, hashDeviceToken(token));
    if (!d) return null;
    await insertAuditLog(client, audit, { action: "temps-deplacements.device.rotate_token", entity_type: "hr_time_clock_devices", entity_id: id, details: {} });
    return d;
  });
  if (!device) throw new HttpError(404, "HR_DEVICE_NOT_FOUND", "Borne introuvable.");
  return { device, token };
}

// -------------------------------------------------------------- Badges
export async function createBadge(actor: Actor, input: { employee_id: string; badge_uid: string; badge_label: string | null }, audit: AuditContext) {
  assertPrivileged(actor);
  const emp = await repoGetEmployeeById(input.employee_id);
  if (!emp) throw new HttpError(404, "HR_EMPLOYEE_NOT_FOUND", "Employé introuvable.");
  return withTransaction(async (client) => {
    const row = await repoCreateBadge(client, { employee_id: input.employee_id, badge_uid_hash: hashBadgeUid(input.badge_uid), badge_label: input.badge_label });
    // JAMAIS le badge_uid en clair dans l'audit.
    await insertAuditLog(client, audit, { action: "temps-deplacements.badge.create", entity_type: "hr_badge_credentials", entity_id: row.id, details: { employee_id: input.employee_id } });
    return row;
  });
}

export async function listBadges(actor: Actor, employeeId?: string) {
  assertPrivileged(actor);
  return withTransaction((client) => repoListBadges(client, employeeId));
}

export async function revokeBadge(actor: Actor, id: string, audit: AuditContext) {
  assertPrivileged(actor);
  const row = await withTransaction(async (client) => {
    const b = await repoRevokeBadge(client, id);
    if (!b) return null;
    await insertAuditLog(client, audit, { action: "temps-deplacements.badge.revoke", entity_type: "hr_badge_credentials", entity_id: id, details: {} });
    return b;
  });
  if (!row) throw new HttpError(409, "HR_BADGE_NOT_ACTIVE", "Badge déjà révoqué ou introuvable.");
  return row;
}
