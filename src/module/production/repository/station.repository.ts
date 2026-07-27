// Repository du poste opérateur tablette (#159).
//
// Règles structurantes appliquées ici et nulle part ailleurs :
//
//   * Ce repository ne pilote AUCUN temps et AUCUNE quantité. Il LIT l'état du
//     moteur #274 (`production_pointages`, `production_quantity_declarations`)
//     et n'y écrit jamais. Démarrer, mettre en pause ou terminer reste l'affaire
//     de `production-execution.repository.ts`.
//   * Il n'écrit JAMAIS dans le domaine RH (#119), le stock, les lots, les
//     réceptions, les BL ni les factures. La liste est déclarée dans le domaine
//     (`FORBIDDEN_STATION_SIDE_EFFECTS`) et vérifiée par test sur ce fichier.
//   * Le TEMPS officiel est posé par la base (`now()`), jamais par la tablette.
//   * Le dossier opérateur est construit par des requêtes AGRÉGÉES : une
//     opération = un aller-retour, pas quinze. Une tablette derrière un Wi-Fi
//     d'atelier ne survit pas à un N+1.

import type { PoolClient } from "pg";

import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";

import {
  assertDeviceUsable,
  fingerprintCredential,
  generateSessionToken,
  hashSessionToken,
  sanitizeAuditDetail,
  type DeviceAssignmentMode,
  type DeviceState,
  type DeviceStatus,
  type IdentificationMethod,
  type StationAuditEventType,
} from "../domain/station";

type DbQueryer = Pick<PoolClient, "query">;

/* -------------------------------------------------------------------------- */
/* Utilitaires                                                                */
/* -------------------------------------------------------------------------- */

function num(value: unknown): number {
  if (value === null || value === undefined) return 0;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function iso(value: unknown): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function toDate(value: unknown): Date {
  const d = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(d.getTime())) throw new HttpError(500, "STATION_INVALID_TIMESTAMP", "Horodatage serveur illisible.");
  return d;
}

/**
 * Poivre de hachage des supports d'identification. Absent, l'identification par
 * badge est REFUSÉE plutôt que dégradée en SHA-256 nu : un UID de badge tient
 * dans un espace de recherche minuscule.
 */
function badgePepper(): string {
  return process.env.STATION_BADGE_PEPPER ?? "";
}

/* -------------------------------------------------------------------------- */
/* Journal d'audit — append-only                                              */
/* -------------------------------------------------------------------------- */

export type StationAuditInput = {
  event_type: StationAuditEventType;
  outcome?: "SUCCESS" | "DENIED" | "ERROR";
  reason_code?: string | null;
  device_id?: string | null;
  session_id?: string | null;
  user_id?: number | null;
  machine_id?: string | null;
  of_id?: number | null;
  operation_id?: string | null;
  detail?: Record<string, unknown>;
  correlation_id?: string | null;
  request_id?: string | null;
};

/**
 * Écrit un événement d'audit. Volontairement tolérant à l'échec : un journal
 * indisponible ne doit pas empêcher un opérateur de travailler, mais l'incident
 * doit rester visible dans les logs applicatifs.
 */
export async function repoStationAudit(input: StationAuditInput, tx?: DbQueryer): Promise<void> {
  const db = tx ?? pool;
  try {
    await db.query(
      `INSERT INTO public.station_audit_events
         (event_type, outcome, reason_code, device_id, session_id, user_id,
          machine_id, of_id, operation_id, detail, correlation_id, request_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12)`,
      [
        input.event_type,
        input.outcome ?? "SUCCESS",
        input.reason_code ?? null,
        input.device_id ?? null,
        input.session_id ?? null,
        input.user_id ?? null,
        input.machine_id ?? null,
        input.of_id ?? null,
        input.operation_id ?? null,
        JSON.stringify(sanitizeAuditDetail(input.detail ?? {})),
        input.correlation_id ?? null,
        input.request_id ?? null,
      ]
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        type: "station_audit_write_failed",
        event_type: input.event_type,
        error: error instanceof Error ? error.name : "unknown",
      })
    );
  }
}

export async function repoListStationAudit(params: {
  device_id?: string;
  user_id?: number;
  event_type?: string;
  outcome?: string;
  limit: number;
}): Promise<unknown[]> {
  const where: string[] = [];
  const values: unknown[] = [];
  if (params.device_id) {
    values.push(params.device_id);
    where.push(`e.device_id = $${values.length}`);
  }
  if (params.user_id) {
    values.push(params.user_id);
    where.push(`e.user_id = $${values.length}`);
  }
  if (params.event_type) {
    values.push(params.event_type);
    where.push(`e.event_type = $${values.length}`);
  }
  if (params.outcome) {
    values.push(params.outcome);
    where.push(`e.outcome = $${values.length}`);
  }
  values.push(params.limit);

  const { rows } = await pool.query(
    `SELECT e.id, e.event_type, e.outcome, e.reason_code, e.detail, e.created_at,
            e.device_id, d.public_code AS device_code,
            e.user_id, u.username AS user_username,
            e.machine_id, m.code AS machine_code,
            e.of_id, e.operation_id
       FROM public.station_audit_events e
       LEFT JOIN public.production_devices d ON d.id = e.device_id
       LEFT JOIN public.users u ON u.id = e.user_id
       LEFT JOIN public.machines m ON m.id = e.machine_id
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY e.created_at DESC, e.id DESC
      LIMIT $${values.length}`,
    values
  );

  return rows.map((r) => ({
    id: Number(r.id),
    event_type: r.event_type as string,
    outcome: r.outcome as string,
    reason_code: r.reason_code as string | null,
    detail: r.detail ?? {},
    created_at: iso(r.created_at),
    device: r.device_id ? { id: r.device_id as string, public_code: r.device_code as string } : null,
    user: r.user_id ? { id: Number(r.user_id), username: r.user_username as string } : null,
    machine: r.machine_id ? { id: r.machine_id as string, code: r.machine_code as string } : null,
    of_id: r.of_id === null || r.of_id === undefined ? null : Number(r.of_id),
    operation_id: (r.operation_id as string | null) ?? null,
  }));
}

/* -------------------------------------------------------------------------- */
/* Appareils                                                                  */
/* -------------------------------------------------------------------------- */

const DEVICE_COLUMNS = `
  d.id, d.public_code, d.label, d.site, d.workshop_zone, d.assignment_mode,
  d.machine_id, d.status, d.auto_lock_seconds, d.session_max_seconds,
  d.last_seen_at, d.last_seen_app_version, d.enrolled_at, d.revoked_at,
  d.revoke_reason, d.created_at, d.updated_at
`;

export type DeviceRow = DeviceState & {
  label: string;
  site: string | null;
  workshop_zone: string | null;
  last_seen_at: string | null;
  last_seen_app_version: string | null;
  enrolled_at: string | null;
  revoked_at: string | null;
  revoke_reason: string | null;
  machine: { id: string; code: string; name: string } | null;
};

function mapDevice(r: Record<string, unknown>): DeviceRow {
  return {
    id: r.id as string,
    public_code: r.public_code as string,
    label: r.label as string,
    site: (r.site as string | null) ?? null,
    workshop_zone: (r.workshop_zone as string | null) ?? null,
    assignment_mode: r.assignment_mode as DeviceAssignmentMode,
    machine_id: (r.machine_id as string | null) ?? null,
    status: r.status as DeviceStatus,
    auto_lock_seconds: num(r.auto_lock_seconds),
    session_max_seconds: num(r.session_max_seconds),
    last_seen_at: iso(r.last_seen_at),
    last_seen_app_version: (r.last_seen_app_version as string | null) ?? null,
    enrolled_at: iso(r.enrolled_at),
    revoked_at: iso(r.revoked_at),
    revoke_reason: (r.revoke_reason as string | null) ?? null,
    machine: r.machine_code
      ? {
          id: r.machine_id as string,
          code: r.machine_code as string,
          name: (r.machine_name as string | null) ?? "",
        }
      : null,
  };
}

export async function repoFindDeviceByCode(code: string, tx?: DbQueryer): Promise<DeviceRow | null> {
  const db = tx ?? pool;
  const { rows } = await db.query(
    `SELECT ${DEVICE_COLUMNS}, m.code AS machine_code, m.name AS machine_name
       FROM public.production_devices d
       LEFT JOIN public.machines m ON m.id = d.machine_id
      WHERE d.public_code = $1`,
    [code]
  );
  return rows[0] ? mapDevice(rows[0]) : null;
}

export async function repoFindDeviceById(id: string, tx?: DbQueryer): Promise<DeviceRow | null> {
  const db = tx ?? pool;
  const { rows } = await db.query(
    `SELECT ${DEVICE_COLUMNS}, m.code AS machine_code, m.name AS machine_name
       FROM public.production_devices d
       LEFT JOIN public.machines m ON m.id = d.machine_id
      WHERE d.id = $1`,
    [id]
  );
  return rows[0] ? mapDevice(rows[0]) : null;
}

export async function repoListDevices(params: {
  status?: string;
  workshop_zone?: string;
  q?: string;
  limit: number;
}): Promise<DeviceRow[]> {
  const where: string[] = [];
  const values: unknown[] = [];
  if (params.status) {
    values.push(params.status);
    where.push(`d.status = $${values.length}`);
  }
  if (params.workshop_zone) {
    values.push(params.workshop_zone);
    where.push(`d.workshop_zone = $${values.length}`);
  }
  if (params.q) {
    values.push(`%${params.q}%`);
    where.push(`(d.public_code ILIKE $${values.length} OR d.label ILIKE $${values.length})`);
  }
  values.push(params.limit);

  const { rows } = await pool.query(
    `SELECT ${DEVICE_COLUMNS}, m.code AS machine_code, m.name AS machine_name
       FROM public.production_devices d
       LEFT JOIN public.machines m ON m.id = d.machine_id
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY d.public_code
      LIMIT $${values.length}`,
    values
  );
  return rows.map(mapDevice);
}

export async function repoEnrollDevice(params: {
  label: string;
  code_prefix: string;
  site?: string | null;
  workshop_zone?: string | null;
  assignment_mode: DeviceAssignmentMode;
  machine_id?: string | null;
  auto_lock_seconds: number;
  session_max_seconds: number;
  actorUserId: number;
}): Promise<DeviceRow> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    if (params.machine_id) {
      const { rowCount } = await client.query(
        `SELECT 1 FROM public.machines WHERE id = $1 AND archived_at IS NULL`,
        [params.machine_id]
      );
      if (!rowCount) {
        throw new HttpError(404, "STATION_MACHINE_UNKNOWN", "Machine introuvable ou archivée.");
      }
    }

    // Le code public est alloué par la BASE : deux enrôlements simultanés ne
    // peuvent pas obtenir le même numéro.
    const { rows: codeRows } = await client.query(
      `SELECT public.fn_production_device_next_public_code($1) AS code`,
      [params.code_prefix]
    );
    const publicCode = codeRows[0]?.code as string;

    const { rows } = await client.query(
      `INSERT INTO public.production_devices
         (public_code, label, site, workshop_zone, assignment_mode, machine_id,
          auto_lock_seconds, session_max_seconds, enrolled_by, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$9)
       RETURNING id`,
      [
        publicCode,
        params.label,
        params.site ?? null,
        params.workshop_zone ?? null,
        params.assignment_mode,
        params.machine_id ?? null,
        params.auto_lock_seconds,
        params.session_max_seconds,
        params.actorUserId,
      ]
    );

    const deviceId = rows[0].id as string;
    await repoStationAudit(
      {
        event_type: "DEVICE_ENROLLED",
        device_id: deviceId,
        user_id: params.actorUserId,
        machine_id: params.machine_id ?? null,
        detail: { public_code: publicCode, assignment_mode: params.assignment_mode },
      },
      client
    );

    await client.query("COMMIT");
    const created = await repoFindDeviceById(deviceId);
    if (!created) throw new HttpError(500, "STATION_DEVICE_CREATE_FAILED", "Appareil créé mais introuvable.");
    return created;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function repoUpdateDevice(params: {
  id: string;
  patch: Record<string, unknown>;
  actorUserId: number;
}): Promise<DeviceRow> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: currentRows } = await client.query(
      `SELECT id, status, assignment_mode, machine_id FROM public.production_devices WHERE id = $1 FOR UPDATE`,
      [params.id]
    );
    const current = currentRows[0];
    if (!current) throw new HttpError(404, "STATION_DEVICE_UNKNOWN", "Appareil introuvable.");
    if (current.status === "REVOKED") {
      throw new HttpError(
        409,
        "STATION_DEVICE_REVOKED",
        "Un appareil révoqué ne peut plus être modifié. Enrôlez-en un nouveau."
      );
    }

    const nextMode = (params.patch.assignment_mode as string | undefined) ?? current.assignment_mode;
    const nextMachine =
      "machine_id" in params.patch ? (params.patch.machine_id as string | null) : current.machine_id;
    if (nextMode === "FIXED" && !nextMachine) {
      throw new HttpError(
        400,
        "STATION_FIXED_REQUIRES_MACHINE",
        "Une tablette fixe doit être affectée à une machine."
      );
    }

    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [key, value] of Object.entries(params.patch)) {
      values.push(value);
      sets.push(`${key} = $${values.length}`);
    }
    values.push(params.actorUserId);
    sets.push(`updated_by = $${values.length}`);
    values.push(params.id);

    await client.query(
      `UPDATE public.production_devices SET ${sets.join(", ")} WHERE id = $${values.length}`,
      values
    );

    await repoStationAudit(
      {
        event_type: params.patch.status === "DISABLED" ? "DEVICE_DISABLED" : "DEVICE_UPDATED",
        device_id: params.id,
        user_id: params.actorUserId,
        detail: { fields: Object.keys(params.patch) },
      },
      client
    );

    await client.query("COMMIT");
    const updated = await repoFindDeviceById(params.id);
    if (!updated) throw new HttpError(404, "STATION_DEVICE_UNKNOWN", "Appareil introuvable.");
    return updated;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Révocation : définitive, et elle FERME toutes les sessions vivantes de
 * l'appareil. Elle n'arrête en revanche AUCUN pointage — le temps déjà déclaré
 * appartient au moteur #274 et à personne d'autre.
 */
export async function repoRevokeDevice(params: {
  id: string;
  reason: string;
  actorUserId: number;
}): Promise<{ device: DeviceRow; closed_sessions: number }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query(
      `UPDATE public.production_devices
          SET status = 'REVOKED', revoked_at = now(), revoked_by = $2,
              revoke_reason = $3, updated_by = $2
        WHERE id = $1 AND status <> 'REVOKED'
        RETURNING id`,
      [params.id, params.actorUserId, params.reason]
    );
    if (!rows[0]) {
      const existing = await repoFindDeviceById(params.id, client);
      if (!existing) throw new HttpError(404, "STATION_DEVICE_UNKNOWN", "Appareil introuvable.");
      await client.query("ROLLBACK");
      return { device: existing, closed_sessions: 0 };
    }

    const closed = await client.query(
      `UPDATE public.operator_device_sessions
          SET state = 'REVOKED', closed_at = now(), close_reason = 'DEVICE_REVOKED'
        WHERE device_id = $1 AND state IN ('ACTIVE', 'LOCKED')
        RETURNING id`,
      [params.id]
    );

    await repoStationAudit(
      {
        event_type: "DEVICE_REVOKED",
        device_id: params.id,
        user_id: params.actorUserId,
        detail: { closed_sessions: closed.rowCount ?? 0 },
      },
      client
    );

    await client.query("COMMIT");
    const device = await repoFindDeviceById(params.id);
    if (!device) throw new HttpError(404, "STATION_DEVICE_UNKNOWN", "Appareil introuvable.");
    return { device, closed_sessions: closed.rowCount ?? 0 };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function repoTouchDeviceSeen(params: {
  device_id: string;
  app_version?: string | null;
}): Promise<void> {
  await pool.query(
    `UPDATE public.production_devices
        SET last_seen_at = now(),
            last_seen_app_version = COALESCE($2, last_seen_app_version)
      WHERE id = $1`,
    [params.device_id, params.app_version ?? null]
  );
}

/* -------------------------------------------------------------------------- */
/* Supports d'identification                                                  */
/* -------------------------------------------------------------------------- */

export async function repoIssueCredential(params: {
  user_id: number;
  credential_type: string;
  credential: string;
  label?: string | null;
  actorUserId: number;
}): Promise<{ id: string; user_id: number; credential_type: string; label: string | null }> {
  const hash = fingerprintCredential(params.credential, badgePepper());

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rowCount } = await client.query(`SELECT 1 FROM public.users WHERE id = $1`, [params.user_id]);
    if (!rowCount) throw new HttpError(404, "STATION_USER_UNKNOWN", "Utilisateur introuvable.");

    const existing = await client.query(
      `SELECT id, user_id, active FROM public.operator_badge_credentials WHERE credential_hash = $1`,
      [hash]
    );
    if (existing.rows[0]) {
      // On ne dit PAS à qui appartient le badge : ce serait un oracle
      // d'énumération. On dit seulement qu'il est déjà connu.
      throw new HttpError(
        409,
        "STATION_CREDENTIAL_ALREADY_ISSUED",
        "Ce support est déjà enregistré dans CERP."
      );
    }

    const { rows } = await client.query(
      `INSERT INTO public.operator_badge_credentials
         (user_id, credential_type, credential_hash, label, issued_by)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id, user_id, credential_type, label`,
      [params.user_id, params.credential_type, hash, params.label ?? null, params.actorUserId]
    );

    await repoStationAudit(
      {
        event_type: "CREDENTIAL_ISSUED",
        user_id: params.actorUserId,
        detail: { subject_user_id: params.user_id, credential_type: params.credential_type },
      },
      client
    );

    await client.query("COMMIT");
    return rows[0];
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function repoRevokeCredential(params: {
  id: string;
  reason: string;
  actorUserId: number;
}): Promise<void> {
  const { rowCount } = await pool.query(
    `UPDATE public.operator_badge_credentials
        SET active = false, revoked_at = now(), revoked_by = $2, revoke_reason = $3
      WHERE id = $1 AND revoked_at IS NULL`,
    [params.id, params.actorUserId, params.reason]
  );
  if (!rowCount) throw new HttpError(404, "STATION_CREDENTIAL_UNKNOWN", "Support introuvable ou déjà révoqué.");
  await repoStationAudit({
    event_type: "CREDENTIAL_REVOKED",
    user_id: params.actorUserId,
    detail: { credential_id: params.id },
  });
}

export async function repoListCredentials(userId: number): Promise<
  Array<{ id: string; credential_type: string; label: string | null; active: boolean; issued_at: string | null }>
> {
  const { rows } = await pool.query(
    `SELECT id, credential_type, label, active, issued_at
       FROM public.operator_badge_credentials
      WHERE user_id = $1
      ORDER BY issued_at DESC`,
    [userId]
  );
  // L'empreinte n'est JAMAIS renvoyée : elle ne sert qu'à comparer côté serveur.
  return rows.map((r) => ({
    id: r.id as string,
    credential_type: r.credential_type as string,
    label: (r.label as string | null) ?? null,
    active: Boolean(r.active),
    issued_at: iso(r.issued_at),
  }));
}

/**
 * Résout un support en utilisateur. Retourne `null` quand le support est
 * inconnu, révoqué ou verrouillé : l'appelant produit alors un message
 * générique, sans révéler laquelle des trois causes s'applique.
 */
export async function repoResolveCredential(rawCredential: string): Promise<
  | { ok: true; credential_id: string; user_id: number }
  | { ok: false; reason: "UNKNOWN" | "REVOKED" | "LOCKED"; credential_id: string | null; locked_until: Date | null }
> {
  const hash = fingerprintCredential(rawCredential, badgePepper());
  const { rows } = await pool.query(
    `SELECT id, user_id, active, revoked_at, locked_until
       FROM public.operator_badge_credentials
      WHERE credential_hash = $1`,
    [hash]
  );
  const row = rows[0];
  if (!row) return { ok: false, reason: "UNKNOWN", credential_id: null, locked_until: null };
  if (!row.active || row.revoked_at) {
    return { ok: false, reason: "REVOKED", credential_id: row.id as string, locked_until: null };
  }
  if (row.locked_until && toDate(row.locked_until).getTime() > Date.now()) {
    return {
      ok: false,
      reason: "LOCKED",
      credential_id: row.id as string,
      locked_until: toDate(row.locked_until),
    };
  }
  return { ok: true, credential_id: row.id as string, user_id: Number(row.user_id) };
}

export async function repoRegisterCredentialSuccess(credentialId: string): Promise<void> {
  await pool.query(
    `UPDATE public.operator_badge_credentials
        SET last_used_at = now(), failed_attempts = 0, locked_until = NULL
      WHERE id = $1`,
    [credentialId]
  );
}

/**
 * Limitation de débit par support. Le compteur est porté par la base : un
 * attaquant qui alterne les tablettes ne remet pas le compteur à zéro.
 */
export async function repoRegisterCredentialFailure(params: {
  credentialId: string | null;
  maxAttempts: number;
  lockSeconds: number;
}): Promise<void> {
  if (!params.credentialId) return;
  await pool.query(
    `UPDATE public.operator_badge_credentials
        SET failed_attempts = failed_attempts + 1,
            locked_until = CASE
              WHEN failed_attempts + 1 >= $2 THEN now() + make_interval(secs => $3)
              ELSE locked_until
            END
      WHERE id = $1`,
    [params.credentialId, params.maxAttempts, params.lockSeconds]
  );
}

/* -------------------------------------------------------------------------- */
/* Sessions de poste                                                          */
/* -------------------------------------------------------------------------- */

export type SessionRow = {
  id: string;
  device_id: string;
  user_id: number;
  machine_id: string | null;
  identification_method: IdentificationMethod;
  state: "ACTIVE" | "LOCKED" | "CLOSED" | "EXPIRED" | "REVOKED";
  started_at: Date;
  last_activity_at: Date;
  expires_at: Date;
  locked_at: Date | null;
  closed_at: Date | null;
  close_reason: string | null;
  correlation_id: string;
};

const SESSION_COLUMNS = `
  s.id, s.device_id, s.user_id, s.machine_id, s.identification_method, s.state,
  s.started_at, s.last_activity_at, s.expires_at, s.locked_at, s.closed_at,
  s.close_reason, s.correlation_id
`;

function mapSession(r: Record<string, unknown>): SessionRow {
  return {
    id: r.id as string,
    device_id: r.device_id as string,
    user_id: Number(r.user_id),
    machine_id: (r.machine_id as string | null) ?? null,
    identification_method: r.identification_method as IdentificationMethod,
    state: r.state as SessionRow["state"],
    started_at: toDate(r.started_at),
    last_activity_at: toDate(r.last_activity_at),
    expires_at: toDate(r.expires_at),
    locked_at: r.locked_at ? toDate(r.locked_at) : null,
    closed_at: r.closed_at ? toDate(r.closed_at) : null,
    close_reason: (r.close_reason as string | null) ?? null,
    correlation_id: r.correlation_id as string,
  };
}

export async function repoFindSessionByToken(token: string): Promise<
  { session: SessionRow; device: DeviceRow; user: { id: number; username: string; name: string | null; surname: string | null; role: string | null } } | null
> {
  const { rows } = await pool.query(
    `SELECT ${SESSION_COLUMNS},
            u.username,
            u.name,
            u.surname,
            concat_ws(
              ' | ',
              u.role,
              (
                SELECT string_agg(ura.role_key, ' | ' ORDER BY ura.role_key)
                FROM public.user_role_assignments ura
                WHERE ura.user_id = u.id
                  AND ura.role_key <> u.role
              )
            ) AS role
       FROM public.operator_device_sessions s
       JOIN public.users u ON u.id = s.user_id
      WHERE s.session_token_hash = $1`,
    [hashSessionToken(token)]
  );
  const row = rows[0];
  if (!row) return null;

  const device = await repoFindDeviceById(row.device_id as string);
  if (!device) return null;

  return {
    session: mapSession(row),
    device,
    user: {
      id: Number(row.user_id),
      username: row.username as string,
      name: (row.name as string | null) ?? null,
      surname: (row.surname as string | null) ?? null,
      role: (row.role as string | null) ?? null,
    },
  };
}

export async function repoFindLiveSessionForDevice(deviceId: string, tx?: DbQueryer): Promise<SessionRow | null> {
  const db = tx ?? pool;
  const { rows } = await db.query(
    `SELECT ${SESSION_COLUMNS}
       FROM public.operator_device_sessions s
      WHERE s.device_id = $1 AND s.state IN ('ACTIVE','LOCKED')
      ORDER BY s.started_at DESC
      LIMIT 1`,
    [deviceId]
  );
  return rows[0] ? mapSession(rows[0]) : null;
}

/**
 * Ouvre une session. Le jeton retourné en clair n'est JAMAIS persisté : seule
 * son empreinte SHA-256 l'est, ce qui rend la révocation immédiate et une fuite
 * de base inexploitable.
 *
 * Si une session vit déjà sur l'appareil, elle est fermée avec un motif
 * explicite — mais AUCUN pointage n'est arrêté au passage.
 */
export async function repoOpenSession(params: {
  device: DeviceRow;
  user_id: number;
  machine_id: string | null;
  identification_method: IdentificationMethod;
  app_version?: string | null;
  request_id?: string | null;
}): Promise<{ session: SessionRow; token: string }> {
  const token = generateSessionToken();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Verrou d'appareil : deux badges présentés simultanément ne créent pas
    // deux sessions vivantes.
    await client.query(`SELECT id FROM public.production_devices WHERE id = $1 FOR UPDATE`, [
      params.device.id,
    ]);

    const previous = await repoFindLiveSessionForDevice(params.device.id, client);
    if (previous) {
      await client.query(
        `UPDATE public.operator_device_sessions
            SET state = 'CLOSED', closed_at = now(), close_reason = 'OPERATOR_SWITCH'
          WHERE id = $1`,
        [previous.id]
      );
      await repoStationAudit(
        {
          event_type: "OPERATOR_SWITCHED",
          device_id: params.device.id,
          session_id: previous.id,
          user_id: params.user_id,
          detail: { previous_user_id: previous.user_id },
        },
        client
      );
    }

    const { rows } = await client.query(
      `INSERT INTO public.operator_device_sessions
         (device_id, user_id, machine_id, identification_method, session_token_hash,
          state, expires_at, client_app_version)
       VALUES ($1,$2,$3,$4,$5,'ACTIVE', now() + make_interval(secs => $6), $7)
       RETURNING ${SESSION_COLUMNS.replace(/s\./g, "")}`,
      [
        params.device.id,
        params.user_id,
        params.machine_id,
        params.identification_method,
        hashSessionToken(token),
        params.device.session_max_seconds,
        params.app_version ?? null,
      ]
    );

    const session = mapSession(rows[0]);

    await client.query(
      `UPDATE public.production_devices
          SET last_seen_at = now(),
              last_seen_app_version = COALESCE($2, last_seen_app_version)
        WHERE id = $1`,
      [params.device.id, params.app_version ?? null]
    );

    await repoStationAudit(
      {
        event_type: "SESSION_OPENED",
        device_id: params.device.id,
        session_id: session.id,
        user_id: params.user_id,
        machine_id: params.machine_id,
        detail: { method: params.identification_method },
        correlation_id: session.correlation_id,
        request_id: params.request_id ?? null,
      },
      client
    );

    await client.query("COMMIT");
    return { session, token };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function repoTouchSession(sessionId: string): Promise<void> {
  await pool.query(
    `UPDATE public.operator_device_sessions
        SET last_activity_at = now()
      WHERE id = $1 AND state = 'ACTIVE'`,
    [sessionId]
  );
}

export async function repoSetSessionState(params: {
  sessionId: string;
  state: "ACTIVE" | "LOCKED" | "CLOSED" | "EXPIRED" | "REVOKED";
  reason?: string | null;
}): Promise<SessionRow> {
  const isTerminal = params.state === "CLOSED" || params.state === "EXPIRED" || params.state === "REVOKED";
  const { rows } = await pool.query(
    `UPDATE public.operator_device_sessions
        SET state = $2,
            locked_at = CASE WHEN $2 = 'LOCKED' THEN now() ELSE NULL END,
            closed_at = CASE WHEN $3 THEN now() ELSE NULL END,
            close_reason = CASE WHEN $3 THEN $4 ELSE NULL END,
            last_activity_at = now()
      WHERE id = $1
      RETURNING ${SESSION_COLUMNS.replace(/s\./g, "")}`,
    [params.sessionId, params.state, isTerminal, params.reason ?? null]
  );
  if (!rows[0]) throw new HttpError(404, "STATION_SESSION_UNKNOWN", "Session introuvable.");
  return mapSession(rows[0]);
}

export async function repoConfirmSessionMachine(params: {
  sessionId: string;
  machineId: string;
}): Promise<SessionRow> {
  const { rows } = await pool.query(
    `UPDATE public.operator_device_sessions
        SET machine_id = $2, last_activity_at = now()
      WHERE id = $1 AND state IN ('ACTIVE','LOCKED')
      RETURNING ${SESSION_COLUMNS.replace(/s\./g, "")}`,
    [params.sessionId, params.machineId]
  );
  if (!rows[0]) throw new HttpError(409, "STATION_SESSION_NOT_LIVE", "Session inactive : reconnectez-vous.");
  return mapSession(rows[0]);
}

/** Machines et OF sur lesquels l'utilisateur a un droit d'écoute temps réel. */
export async function repoUserRealtimeScope(userId: number): Promise<{
  machineIds: string[];
  ofIds: number[];
  deviceIds: string[];
}> {
  const { rows } = await pool.query(
    `SELECT
       COALESCE((
         SELECT array_agg(DISTINCT s.machine_id::text)
           FROM public.operator_device_sessions s
          WHERE s.user_id = $1 AND s.state IN ('ACTIVE','LOCKED') AND s.machine_id IS NOT NULL
       ), '{}') AS machine_ids,
       COALESCE((
         SELECT array_agg(DISTINCT p.of_id)
           FROM public.production_pointages p
          WHERE p.operator_user_id = $1 AND p.status = 'RUNNING'
       ), '{}') AS of_ids,
       COALESCE((
         SELECT array_agg(DISTINCT s.device_id::text)
           FROM public.operator_device_sessions s
          WHERE s.user_id = $1 AND s.state IN ('ACTIVE','LOCKED')
       ), '{}') AS device_ids`,
    [userId]
  );
  const r = rows[0] ?? {};
  return {
    machineIds: (r.machine_ids as string[] | null) ?? [],
    ofIds: ((r.of_ids as (number | string)[] | null) ?? []).map((v) => Number(v)),
    deviceIds: (r.device_ids as string[] | null) ?? [],
  };
}

/* -------------------------------------------------------------------------- */
/* Machines sélectionnables                                                   */
/* -------------------------------------------------------------------------- */

export type MachineOccupancyRow = {
  id: string;
  code: string;
  name: string;
  status: string;
  is_available: boolean;
  workshop_zone: string | null;
  archived_at: Date | null;
  active_operator_user_id: number | null;
  active_operator_label: string | null;
  active_of_id: number | null;
  active_of_numero: string | null;
  active_since: string | null;
};

export async function repoListSelectableMachines(params: {
  workshop_zone: string | null;
  limit?: number;
}): Promise<MachineOccupancyRow[]> {
  const { rows } = await pool.query(
    `SELECT o.machine_id AS id, o.machine_code AS code, o.machine_name AS name,
            o.machine_status::text AS status, o.machine_is_available AS is_available,
            o.workshop_zone, NULL::timestamptz AS archived_at,
            o.active_operator_user_id,
            CASE WHEN u.id IS NULL THEN NULL
                 ELSE COALESCE(NULLIF(btrim(COALESCE(u.name,'') || ' ' || COALESCE(u.surname,'')), ''), u.username)
            END AS active_operator_label,
            o.active_of_id, ofa.numero AS active_of_numero, o.active_since
       FROM public.v_station_machine_occupancy o
       LEFT JOIN public.users u ON u.id = o.active_operator_user_id
       LEFT JOIN public.ordres_fabrication ofa ON ofa.id = o.active_of_id
      WHERE ($1::text IS NULL OR o.workshop_zone IS NULL OR o.workshop_zone = $1)
      ORDER BY o.machine_code
      LIMIT $2`,
    [params.workshop_zone, params.limit ?? 200]
  );

  return rows.map((r) => ({
    id: r.id as string,
    code: r.code as string,
    name: r.name as string,
    status: String(r.status ?? ""),
    is_available: Boolean(r.is_available),
    workshop_zone: (r.workshop_zone as string | null) ?? null,
    archived_at: null,
    active_operator_user_id:
      r.active_operator_user_id === null || r.active_operator_user_id === undefined
        ? null
        : Number(r.active_operator_user_id),
    active_operator_label: (r.active_operator_label as string | null) ?? null,
    active_of_id: r.active_of_id === null || r.active_of_id === undefined ? null : Number(r.active_of_id),
    active_of_numero: (r.active_of_numero as string | null) ?? null,
    active_since: iso(r.active_since),
  }));
}

export async function repoFindMachineOccupancy(machineId: string): Promise<MachineOccupancyRow | null> {
  const all = await repoListSelectableMachines({ workshop_zone: null, limit: 1000 });
  return all.find((m) => m.id === machineId) ?? null;
}

/* -------------------------------------------------------------------------- */
/* File de travail                                                            */
/* -------------------------------------------------------------------------- */

export type WorklistRow = {
  operation_id: string;
  phase: number;
  designation: string;
  operation_status: string;
  temps_total_planned: number;
  temps_total_real: number;
  of_id: number;
  of_numero: string;
  of_statut: string;
  of_priority: string;
  date_fin_prevue: string | null;
  quantite_lancee: number;
  quantite_bonne: number;
  quantite_rebut: number;
  qty_pending_control: number;
  piece_code: string | null;
  piece_designation: string | null;
  affaire_id: number | null;
  affaire_reference: string | null;
  machine_id: string | null;
  machine_code: string | null;
  machine_name: string | null;
  machine_is_available: boolean;
  has_pending_predecessor: boolean;
  active_by_user_id: number | null;
  has_technical_snapshot: boolean;
  has_plan_document: boolean;
  first_article_required: boolean;
  first_article_passed: boolean;
  parent_of_id: number | null;
  child_of_count: number;
  child_of_pending: number;
};

/**
 * File de travail, en UNE requête.
 *
 * Chaque signal est calculé côté base par un agrégat corrélé ; il n'y a donc ni
 * boucle applicative, ni requête par ligne. Le filtrage (utilisateur, machine,
 * atelier, statut d'OF) est SERVEUR : le client ne reçoit jamais une file
 * complète qu'il devrait filtrer lui-même.
 */
export async function repoWorklist(params: {
  userId: number;
  machineId: string | null;
  workshopZone: string | null;
  q: string | null;
  machineOnly: boolean;
  includeBlocked: boolean;
  limit: number;
}): Promise<WorklistRow[]> {
  const { rows } = await pool.query(
    `
    WITH candidate_ops AS (
      SELECT op.id AS operation_id, op.phase, op.designation, op.status::text AS operation_status,
             op.temps_total_planned, op.temps_total_real, op.machine_id,
             o.id AS of_id, o.numero AS of_numero, o.statut::text AS of_statut,
             o.priority::text AS of_priority, o.date_fin_prevue,
             o.quantite_lancee, o.quantite_bonne, o.quantite_rebut,
             o.piece_technique_id, o.affaire_id, o.parent_of_id,
             o.technical_snapshot_sha256, o.piece_technique_version_id
        FROM public.of_operations op
        JOIN public.ordres_fabrication o ON o.id = op.of_id
       WHERE o.statut::text NOT IN ('BROUILLON', 'ANNULE', 'TERMINE')
         AND op.status::text NOT IN ('DONE', 'CANCELLED')
         AND ($2::uuid IS NULL OR NOT $5::boolean OR op.machine_id = $2 OR op.machine_id IS NULL)
         AND (
           $3::text IS NULL
           OR o.numero ILIKE '%' || $3 || '%'
           OR op.designation ILIKE '%' || $3 || '%'
           OR EXISTS (
             SELECT 1 FROM public.pieces_techniques pt
              WHERE pt.id = o.piece_technique_id
                AND (pt.code_piece ILIKE '%' || $3 || '%' OR pt.designation ILIKE '%' || $3 || '%')
           )
         )
       LIMIT 500
    )
    SELECT c.*,
           pt.code_piece AS piece_code,
           pt.designation AS piece_designation,
           a.reference AS affaire_reference,
           m.code AS machine_code, m.name AS machine_name,
           COALESCE(m.is_available, true) AS machine_is_available,
           COALESCE(qc.qty_pending_control, 0) AS qty_pending_control,
           EXISTS (
             SELECT 1 FROM public.of_operations prev
              WHERE prev.of_id = c.of_id
                AND prev.phase < c.phase
                AND prev.status::text NOT IN ('DONE', 'CANCELLED')
           ) AS has_pending_predecessor,
           (
             SELECT p.operator_user_id
               FROM public.production_pointages p
              WHERE p.operation_id = c.operation_id AND p.status = 'RUNNING'
              ORDER BY p.start_ts DESC
              LIMIT 1
           ) AS active_by_user_id,
           (c.technical_snapshot_sha256 IS NOT NULL) AS has_technical_snapshot,
           EXISTS (
             SELECT 1 FROM public.pieces_techniques_documents d
              WHERE d.piece_technique_id = c.piece_technique_id
                AND d.removed_at IS NULL
           ) AS has_plan_document,
           EXISTS (
             SELECT 1
               FROM public.quality_control_plan qcp
              WHERE qcp.status = 'PUBLISHED'
                AND qcp.trigger_type = 'FIRST_ARTICLE'
                AND (
                  qcp.piece_version_id = c.piece_technique_version_id
                  OR qcp.piece_technique_id = c.piece_technique_id
                )
           ) AS first_article_required,
           EXISTS (
             SELECT 1
               FROM public.quality_control qc2
              WHERE qc2.of_id = c.of_id
                AND qc2.trigger_type = 'FIRST_ARTICLE'
                AND COALESCE(qc2.verdict, qc2.verdict_computed) = 'CONFORME'
           ) AS first_article_passed,
           (
             SELECT count(*) FROM public.ordres_fabrication child
              WHERE child.parent_of_id = c.of_id
           ) AS child_of_count,
           (
             SELECT count(*) FROM public.ordres_fabrication child
              WHERE child.parent_of_id = c.of_id
                AND child.statut::text NOT IN ('TERMINE', 'ANNULE')
           ) AS child_of_pending
      FROM candidate_ops c
      LEFT JOIN public.pieces_techniques pt ON pt.id = c.piece_technique_id
      LEFT JOIN public.affaire a ON a.id = c.affaire_id
      LEFT JOIN public.machines m ON m.id = c.machine_id
      LEFT JOIN LATERAL (
        SELECT SUM(d.qty_pending_control) AS qty_pending_control
          FROM public.production_quantity_declarations d
         WHERE d.operation_id = c.operation_id
      ) qc ON true
     WHERE ($4::text IS NULL OR m.workshop_zone IS NULL OR m.workshop_zone = $4)
     ORDER BY c.date_fin_prevue NULLS LAST, c.phase
     LIMIT $6
    `,
    [
      params.userId,
      params.machineId,
      params.q,
      params.workshopZone,
      params.machineOnly,
      params.limit,
    ]
  );

  return rows.map((r) => ({
    operation_id: r.operation_id as string,
    phase: num(r.phase),
    designation: r.designation as string,
    operation_status: String(r.operation_status ?? ""),
    temps_total_planned: num(r.temps_total_planned),
    temps_total_real: num(r.temps_total_real),
    of_id: num(r.of_id),
    of_numero: r.of_numero as string,
    of_statut: String(r.of_statut ?? ""),
    of_priority: String(r.of_priority ?? ""),
    date_fin_prevue: r.date_fin_prevue ? String(r.date_fin_prevue).slice(0, 10) : null,
    quantite_lancee: num(r.quantite_lancee),
    quantite_bonne: num(r.quantite_bonne),
    quantite_rebut: num(r.quantite_rebut),
    qty_pending_control: num(r.qty_pending_control),
    piece_code: (r.piece_code as string | null) ?? null,
    piece_designation: (r.piece_designation as string | null) ?? null,
    affaire_id: r.affaire_id === null || r.affaire_id === undefined ? null : num(r.affaire_id),
    affaire_reference: (r.affaire_reference as string | null) ?? null,
    machine_id: (r.machine_id as string | null) ?? null,
    machine_code: (r.machine_code as string | null) ?? null,
    machine_name: (r.machine_name as string | null) ?? null,
    machine_is_available: Boolean(r.machine_is_available),
    has_pending_predecessor: Boolean(r.has_pending_predecessor),
    active_by_user_id:
      r.active_by_user_id === null || r.active_by_user_id === undefined ? null : Number(r.active_by_user_id),
    has_technical_snapshot: Boolean(r.has_technical_snapshot),
    has_plan_document: Boolean(r.has_plan_document),
    first_article_required: Boolean(r.first_article_required),
    first_article_passed: Boolean(r.first_article_passed),
    parent_of_id: r.parent_of_id === null || r.parent_of_id === undefined ? null : num(r.parent_of_id),
    child_of_count: num(r.child_of_count),
    child_of_pending: num(r.child_of_pending),
  }));
}

/* -------------------------------------------------------------------------- */
/* Dossier opérateur                                                          */
/* -------------------------------------------------------------------------- */

export type DossierRaw = {
  of: Record<string, unknown>;
  operation: Record<string, unknown>;
  client: Record<string, unknown> | null;
  documents: Array<Record<string, unknown>>;
  instructions: Array<Record<string, unknown>>;
  materials: Array<Record<string, unknown>>;
  characteristics: Array<Record<string, unknown>>;
  instruments: Array<Record<string, unknown>>;
  machineDocuments: Array<Record<string, unknown>>;
  children: Array<Record<string, unknown>>;
  activeExecution: Record<string, unknown> | null;
  declarations: Record<string, unknown> | null;
};

/**
 * Dossier OF numérique, en UNE requête agrégée.
 *
 * Chaque bloc est un sous-agrégat JSON : le serveur assemble, le client affiche.
 * L'alternative — dix requêtes enchaînées depuis le navigateur — multiplierait
 * la latence par dix sur un réseau d'atelier et rendrait l'écran inutilisable
 * derrière une cloison métallique.
 *
 * `storage_path` n'est JAMAIS sélectionné : le téléchargement passe par la route
 * de document existante, qui applique ses propres contrôles.
 */
export async function repoDossier(params: {
  ofId: number;
  operationId: string;
  userId: number;
}): Promise<DossierRaw | null> {
  const { rows } = await pool.query(
    `
    WITH base AS (
      SELECT o.id AS of_id, o.numero, o.statut::text AS statut, o.priority::text AS priority,
             o.quantite_lancee, o.quantite_bonne, o.quantite_rebut,
             o.date_lancement_prevue, o.date_fin_prevue,
             o.piece_technique_id, o.piece_technique_version_id,
             o.technical_snapshot, o.technical_snapshot_sha256, o.technical_snapshot_at,
             o.affaire_id, o.commande_id, o.client_id, o.parent_of_id, o.root_of_id,
             o.structure_path, o.quantity_per_parent, o.quantity_cumulative, o.notes,
             op.id AS operation_id, op.phase, op.designation AS operation_designation,
             op.status::text AS operation_status, op.temps_total_planned, op.temps_total_real,
             op.machine_id, op.poste_id, op.notes AS operation_notes,
             op.source_piece_operation_id, op.tp, op.tf_unit, op.qte, op.coef
        FROM public.ordres_fabrication o
        JOIN public.of_operations op ON op.of_id = o.id
       WHERE o.id = $1 AND op.id = $2
    )
    SELECT
      to_jsonb(b) - 'technical_snapshot' AS of_core,
      b.technical_snapshot AS technical_snapshot,
      to_jsonb(pt) AS piece,
      to_jsonb(ptv) AS piece_version,
      to_jsonb(a) AS affaire,
      CASE
        WHEN c.client_id IS NULL THEN NULL
        ELSE jsonb_build_object(
          'id', c.client_id::text,
          'code', COALESCE(
            NULLIF(btrim(to_jsonb(c)->>'client_code'), ''),
            NULLIF(btrim(to_jsonb(c)->>'code_client'), '')
          ),
          'company_name', c.company_name,
          'logo_path', c.logo_path
        )
      END AS client,
      to_jsonb(m) AS machine,
      to_jsonb(po) AS poste,

      -- Documents de la pièce technique : jamais storage_path.
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
                 'id', d.id, 'label', d.label, 'original_name', d.original_name,
                 'mime_type', d.mime_type, 'size_bytes', d.size_bytes, 'sha256', d.sha256,
                 'created_at', d.created_at
               ) ORDER BY d.created_at DESC)
          FROM public.pieces_techniques_documents d
         WHERE d.piece_technique_id = b.piece_technique_id AND d.removed_at IS NULL
      ), '[]'::jsonb) AS documents,

      -- Instruction de l'opération : consignes de la gamme + dossier atelier.
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
                 'source', 'GAMME', 'phase', pto.phase, 'designation', pto.designation,
                 'designation_2', pto.designation_2, 'consignes', pto.consignes,
                 'type_operation', pto.type_operation, 'tp', pto.tp, 'tf_unit', pto.tf_unit
               ) ORDER BY pto.phase)
          FROM public.pieces_techniques_operations pto
         WHERE pto.piece_technique_id = b.piece_technique_id
           AND (b.source_piece_operation_id IS NULL OR pto.id = b.source_piece_operation_id)
      ), '[]'::jsonb) AS instructions,

      -- Documents du dossier atelier versionné (dernière version).
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
                 'id', dvd.id, 'slot_key', dvd.slot_key, 'label', dvd.label,
                 'commentaire', dvd.commentaire, 'document_id', dvd.document_id,
                 'mime_type', dvd.mime_type, 'file_name', dvd.file_name,
                 'file_size_bytes', dvd.file_size_bytes
               ) ORDER BY dvd.slot_key)
          FROM public.operation_dossiers od
          JOIN LATERAL (
            SELECT odv.id FROM public.operation_dossier_versions odv
             WHERE odv.dossier_id = od.id
             ORDER BY odv.version DESC LIMIT 1
          ) last_version ON true
          JOIN public.operation_dossier_version_documents dvd
            ON dvd.dossier_version_id = last_version.id
         WHERE od.operation_type = 'OF_OPERATION'
           AND od.operation_id = b.operation_id::text
      ), '[]'::jsonb) AS dossier_documents,

      -- Matière consommée (LECTURE SEULE : le poste ne consomme rien).
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
                 'id', mc.id, 'article_id', mc.article_id, 'article_code', ar.code,
                 'article_designation', ar.designation, 'lot_id', mc.lot_id,
                 'lot_code', l.lot_code, 'supplier_lot_code', l.supplier_lot_code,
                 'lot_status', l.lot_status, 'qty', mc.qty, 'unit_code', mc.unit_code,
                 'effective_at', mc.effective_at, 'status', mc.status
               ) ORDER BY mc.effective_at DESC)
          FROM public.of_material_consumptions mc
          LEFT JOIN public.articles ar ON ar.id = mc.article_id
          LEFT JOIN public.lots l ON l.id = mc.lot_id
         WHERE mc.of_id = b.of_id
           AND (mc.of_operation_id IS NULL OR mc.of_operation_id = b.operation_id)
      ), '[]'::jsonb) AS materials,

      -- Caractéristiques à contrôler, issues des plans PUBLIÉS applicables.
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
                 'plan_id', qcp.id, 'plan_code', qcp.code, 'plan_version', qcp.version,
                 'plan_label', qcp.label, 'plan_trigger', qcp.trigger_type,
                 'sampling_rule', ch.sampling_rule, 'sampling_value', ch.sampling_value,
                 'characteristic_key', ch.characteristic_key, 'label', ch.label,
                 'characteristic_type', ch.characteristic_type, 'value_kind', ch.value_kind,
                 'unit', ch.unit, 'nominal', ch.nominal,
                 'tolerance_min', ch.tolerance_min, 'tolerance_max', ch.tolerance_max,
                 'criticality', ch.criticality, 'mandatory', ch.mandatory,
                 'requires_instrument', ch.requires_instrument,
                 'instrument_category', ch.instrument_category,
                 'method', ch.method, 'trigger_type', ch.trigger_type,
                 'position', ch.position
               ) ORDER BY qcp.trigger_type, ch.position)
          FROM public.quality_control_plan qcp
          JOIN public.quality_control_plan_characteristic ch ON ch.plan_id = qcp.id
         WHERE qcp.status = 'PUBLISHED'
           AND (qcp.effective_to IS NULL OR qcp.effective_to > now())
           AND (
             qcp.piece_version_id = b.piece_technique_version_id
             OR qcp.piece_technique_id = b.piece_technique_id
           )
      ), '[]'::jsonb) AS characteristics,

      -- Contrôles déjà prononcés sur cet OF.
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
                 'id', qc.id, 'reference', qc.reference, 'trigger_type', qc.trigger_type,
                 'status', qc.status, 'verdict', COALESCE(qc.verdict, qc.verdict_computed),
                 'control_date', qc.control_date, 'qty_controlled', qc.qty_controlled,
                 'qty_conforming', qc.qty_conforming, 'operation_id', qc.operation_id
               ) ORDER BY qc.control_date DESC NULLS LAST)
          FROM public.quality_control qc
         WHERE qc.of_id = b.of_id
      ), '[]'::jsonb) AS controls,

      -- Instruments disponibles, avec leur état d'étalonnage réel.
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
                 'id', e.id, 'code', e.code, 'designation', e.designation,
                 'categorie', e.categorie, 'categorie_code', e.categorie_code,
                 'statut', e.statut, 'etat', e.etat, 'criticite', e.criticite,
                 'unite', e.unite, 'plage_min', e.plage_min, 'plage_max', e.plage_max,
                 'resolution', e.resolution, 'exige_certificat', e.exige_certificat,
                 'quarantine_reason', e.quarantine_reason,
                 'last_conforme_at', e.last_conforme_at
               ) ORDER BY e.code NULLS LAST, e.designation)
          FROM public.metrologie_equipements e
         WHERE e.deleted_at IS NULL
           AND COALESCE(e.statut, 'ACTIF') = 'ACTIF'
         LIMIT 200
      ), '[]'::jsonb) AS instruments,

      -- Fiche machine et sa documentation approuvée.
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
                 'id', md.id, 'title', md.title, 'document_type', md.document_type,
                 'revision', md.revision, 'mime_type', md.mime_type,
                 'size_bytes', md.size_bytes, 'sha256', md.sha256, 'url', md.url
               ) ORDER BY md.document_type, md.title)
          FROM public.production_machine_documents md
         WHERE md.machine_id = b.machine_id AND md.removed_at IS NULL
      ), '[]'::jsonb) AS machine_documents,

      -- Hiérarchie : OF enfants et leur avancement.
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
                 'of_id', child.id, 'numero', child.numero, 'statut', child.statut,
                 'quantite_lancee', child.quantite_lancee, 'quantite_bonne', child.quantite_bonne,
                 'quantite_rebut', child.quantite_rebut,
                 'piece_code', cpt.code_piece, 'piece_designation', cpt.designation
               ) ORDER BY child.numero)
          FROM public.ordres_fabrication child
          LEFT JOIN public.pieces_techniques cpt ON cpt.id = child.piece_technique_id
         WHERE child.parent_of_id = b.of_id
      ), '[]'::jsonb) AS children,

      -- OF parent, s'il existe.
      (
        SELECT jsonb_build_object(
                 'of_id', parent.id, 'numero', parent.numero, 'statut', parent.statut,
                 'piece_code', ppt.code_piece, 'piece_designation', ppt.designation
               )
          FROM public.ordres_fabrication parent
          LEFT JOIN public.pieces_techniques ppt ON ppt.id = parent.piece_technique_id
         WHERE parent.id = b.parent_of_id
      ) AS parent,

      -- Exécution en cours de CET opérateur sur CETTE opération (moteur #274).
      (
        SELECT jsonb_build_object(
                 'id', p.id, 'activity_code', p.activity_code, 'start_ts', p.start_ts,
                 'operator_user_id', p.operator_user_id, 'machine_id', p.machine_id,
                 'elapsed_minutes', floor(EXTRACT(EPOCH FROM (now() - p.start_ts)) / 60)
               )
          FROM public.production_pointages p
         WHERE p.operation_id = b.operation_id AND p.status = 'RUNNING'
         ORDER BY p.start_ts DESC
         LIMIT 1
      ) AS active_execution,

      -- Cumul des déclarations sur l'opération.
      (
        SELECT jsonb_build_object(
                 'qty_good', COALESCE(SUM(d.qty_good), 0),
                 'qty_scrap', COALESCE(SUM(d.qty_scrap), 0),
                 'qty_rework', COALESCE(SUM(d.qty_rework), 0),
                 'qty_pending_control', COALESCE(SUM(d.qty_pending_control), 0)
               )
          FROM public.production_quantity_declarations d
         WHERE d.operation_id = b.operation_id
      ) AS declarations,

      -- Transmission de poste non accusée sur cette opération.
      (
        SELECT jsonb_build_object(
                 'id', h.id, 'created_at', h.created_at, 'machine_state', h.machine_state,
                 'defects', h.defects, 'tooling_left', h.tooling_left,
                 'remaining_actions', h.remaining_actions, 'comment', h.comment,
                 'qty_done', h.qty_done,
                 'outgoing_user', COALESCE(NULLIF(btrim(COALESCE(ou.name,'') || ' ' || COALESCE(ou.surname,'')), ''), ou.username)
               )
          FROM public.production_shift_handovers h
          LEFT JOIN public.users ou ON ou.id = h.outgoing_user_id
         WHERE h.operation_id = b.operation_id
           AND h.incoming_user_id = $3
           AND h.acknowledged_at IS NULL
         ORDER BY h.created_at DESC
         LIMIT 1
      ) AS pending_handover,

      -- Indice courant de la pièce, pour signaler une évolution SANS l'appliquer.
      (
        SELECT ptv2.indice
          FROM public.piece_technique_versions ptv2
         WHERE ptv2.piece_technique_id = b.piece_technique_id AND ptv2.is_current
         LIMIT 1
      ) AS latest_indice

    FROM base b
    LEFT JOIN public.pieces_techniques pt ON pt.id = b.piece_technique_id
    LEFT JOIN public.piece_technique_versions ptv ON ptv.id = b.piece_technique_version_id
    LEFT JOIN public.affaire a ON a.id = b.affaire_id
    LEFT JOIN public.clients c ON c.client_id = b.client_id
    LEFT JOIN public.machines m ON m.id = b.machine_id
    LEFT JOIN public.postes po ON po.id = b.poste_id
    `,
    [params.ofId, params.operationId, params.userId]
  );

  const row = rows[0];
  if (!row) return null;
  return row as unknown as DossierRaw;
}

/* -------------------------------------------------------------------------- */
/* Résolution de scan                                                         */
/* -------------------------------------------------------------------------- */

export async function repoResolveScan(code: string): Promise<
  { of_id: number; of_numero: string; operation_id: string | null; phase: number | null } | null
> {
  // Formats acceptés : « OF-2026-0007 », « OF-2026-0007/30 », une URL CERP se
  // terminant par l'un des deux, ou un identifiant numérique d'OF.
  const cleaned = code.trim().replace(/^.*\/(?=[A-Za-z0-9-]+(?:\/\d+)?$)/, "");
  const match = /^([A-Za-z0-9-]+?)(?:\/(\d+))?$/.exec(cleaned);
  if (!match) return null;

  const numero = match[1];
  const phase = match[2] ? Number(match[2]) : null;

  const { rows } = await pool.query(
    `SELECT o.id, o.numero,
            (SELECT op.id FROM public.of_operations op
              WHERE op.of_id = o.id
                AND ($2::int IS NULL OR op.phase = $2)
                AND op.status::text NOT IN ('DONE','CANCELLED')
              ORDER BY op.phase LIMIT 1) AS operation_id,
            (SELECT op.phase FROM public.of_operations op
              WHERE op.of_id = o.id
                AND ($2::int IS NULL OR op.phase = $2)
                AND op.status::text NOT IN ('DONE','CANCELLED')
              ORDER BY op.phase LIMIT 1) AS phase
       FROM public.ordres_fabrication o
      WHERE o.numero = $1 OR ($3::bigint IS NOT NULL AND o.id = $3::bigint)
      LIMIT 1`,
    [numero, phase, /^\d+$/.test(numero) ? numero : null]
  );

  const row = rows[0];
  if (!row) return null;
  return {
    of_id: num(row.id),
    of_numero: row.numero as string,
    operation_id: (row.operation_id as string | null) ?? null,
    phase: row.phase === null || row.phase === undefined ? null : num(row.phase),
  };
}

/* -------------------------------------------------------------------------- */
/* Transmission de poste                                                      */
/* -------------------------------------------------------------------------- */

export type HandoverRow = {
  id: string;
  device_id: string | null;
  machine_id: string | null;
  machine_code: string | null;
  of_id: number | null;
  of_numero: string | null;
  operation_id: string | null;
  pointage_id: string | null;
  outgoing_user: { id: number; label: string };
  incoming_user: { id: number; label: string };
  machine_state: string;
  qty_done: number | null;
  defects: string | null;
  tooling_left: string | null;
  remaining_actions: string | null;
  comment: string | null;
  created_at: string | null;
  acknowledged_at: string | null;
};

const HANDOVER_SELECT = `
  SELECT h.id, h.device_id, h.machine_id, m.code AS machine_code,
         h.of_id, o.numero AS of_numero, h.operation_id, h.pointage_id,
         h.outgoing_user_id, h.incoming_user_id,
         COALESCE(NULLIF(btrim(COALESCE(ou.name,'') || ' ' || COALESCE(ou.surname,'')), ''), ou.username) AS outgoing_label,
         COALESCE(NULLIF(btrim(COALESCE(iu.name,'') || ' ' || COALESCE(iu.surname,'')), ''), iu.username) AS incoming_label,
         h.machine_state, h.qty_done, h.defects, h.tooling_left, h.remaining_actions,
         h.comment, h.created_at, h.acknowledged_at
    FROM public.production_shift_handovers h
    LEFT JOIN public.machines m ON m.id = h.machine_id
    LEFT JOIN public.ordres_fabrication o ON o.id = h.of_id
    LEFT JOIN public.users ou ON ou.id = h.outgoing_user_id
    LEFT JOIN public.users iu ON iu.id = h.incoming_user_id
`;

function mapHandover(r: Record<string, unknown>): HandoverRow {
  return {
    id: r.id as string,
    device_id: (r.device_id as string | null) ?? null,
    machine_id: (r.machine_id as string | null) ?? null,
    machine_code: (r.machine_code as string | null) ?? null,
    of_id: r.of_id === null || r.of_id === undefined ? null : num(r.of_id),
    of_numero: (r.of_numero as string | null) ?? null,
    operation_id: (r.operation_id as string | null) ?? null,
    pointage_id: (r.pointage_id as string | null) ?? null,
    outgoing_user: { id: Number(r.outgoing_user_id), label: (r.outgoing_label as string) ?? "" },
    incoming_user: { id: Number(r.incoming_user_id), label: (r.incoming_label as string) ?? "" },
    machine_state: r.machine_state as string,
    qty_done: r.qty_done === null || r.qty_done === undefined ? null : num(r.qty_done),
    defects: (r.defects as string | null) ?? null,
    tooling_left: (r.tooling_left as string | null) ?? null,
    remaining_actions: (r.remaining_actions as string | null) ?? null,
    comment: (r.comment as string | null) ?? null,
    created_at: iso(r.created_at),
    acknowledged_at: iso(r.acknowledged_at),
  };
}

export async function repoCreateHandover(params: {
  device_id: string | null;
  machine_id: string | null;
  of_id: number | null;
  operation_id: string | null;
  pointage_id: string | null;
  outgoing_user_id: number;
  incoming_user_id: number;
  machine_state: string;
  qty_done: number | null;
  defects: string | null;
  tooling_left: string | null;
  remaining_actions: string | null;
  comment: string | null;
  idempotency_key: string;
}): Promise<HandoverRow> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Rejeu : la même clé renvoie la même transmission, pas une seconde.
    const existing = await client.query(
      `SELECT id FROM public.production_shift_handovers WHERE idempotency_key = $1`,
      [params.idempotency_key]
    );
    if (existing.rows[0]) {
      await client.query("ROLLBACK");
      const replayed = await repoGetHandover(existing.rows[0].id as string);
      if (!replayed) throw new HttpError(500, "STATION_HANDOVER_REPLAY_FAILED", "Transmission introuvable au rejeu.");
      return replayed;
    }

    const { rowCount: incomingExists } = await client.query(
      `SELECT 1 FROM public.users WHERE id = $1`,
      [params.incoming_user_id]
    );
    if (!incomingExists) {
      throw new HttpError(404, "STATION_USER_UNKNOWN", "Opérateur entrant introuvable.");
    }

    const { rows } = await client.query(
      `INSERT INTO public.production_shift_handovers
         (device_id, machine_id, of_id, operation_id, pointage_id,
          outgoing_user_id, incoming_user_id, machine_state, qty_done,
          defects, tooling_left, remaining_actions, comment, created_by, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$6,$14)
       RETURNING id`,
      [
        params.device_id,
        params.machine_id,
        params.of_id,
        params.operation_id,
        params.pointage_id,
        params.outgoing_user_id,
        params.incoming_user_id,
        params.machine_state,
        params.qty_done,
        params.defects,
        params.tooling_left,
        params.remaining_actions,
        params.comment,
        params.idempotency_key,
      ]
    );

    const id = rows[0].id as string;
    await repoStationAudit(
      {
        event_type: "HANDOVER_CREATED",
        device_id: params.device_id,
        user_id: params.outgoing_user_id,
        machine_id: params.machine_id,
        of_id: params.of_id,
        operation_id: params.operation_id,
        detail: { handover_id: id, incoming_user_id: params.incoming_user_id },
      },
      client
    );

    await client.query("COMMIT");
    const created = await repoGetHandover(id);
    if (!created) throw new HttpError(500, "STATION_HANDOVER_CREATE_FAILED", "Transmission créée mais introuvable.");
    return created;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function repoGetHandover(id: string): Promise<HandoverRow | null> {
  const { rows } = await pool.query(`${HANDOVER_SELECT} WHERE h.id = $1`, [id]);
  return rows[0] ? mapHandover(rows[0]) : null;
}

export async function repoListHandoversForUser(params: {
  userId: number;
  onlyPending: boolean;
  limit: number;
}): Promise<HandoverRow[]> {
  const { rows } = await pool.query(
    `${HANDOVER_SELECT}
      WHERE (h.incoming_user_id = $1 OR h.outgoing_user_id = $1)
        AND ($2::boolean = false OR h.acknowledged_at IS NULL)
      ORDER BY h.created_at DESC
      LIMIT $3`,
    [params.userId, params.onlyPending, params.limit]
  );
  return rows.map(mapHandover);
}

export async function repoAcknowledgeHandover(params: {
  id: string;
  actorUserId: number;
}): Promise<HandoverRow> {
  const { rows } = await pool.query(
    `UPDATE public.production_shift_handovers
        SET acknowledged_at = now(), acknowledged_by = $2
      WHERE id = $1 AND acknowledged_at IS NULL
      RETURNING id`,
    [params.id, params.actorUserId]
  );
  if (!rows[0]) {
    throw new HttpError(
      409,
      "STATION_HANDOVER_ALREADY_ACKNOWLEDGED",
      "Cette transmission a déjà été accusée de réception."
    );
  }
  await repoStationAudit({
    event_type: "HANDOVER_ACKNOWLEDGED",
    user_id: params.actorUserId,
    detail: { handover_id: params.id },
  });
  const updated = await repoGetHandover(params.id);
  if (!updated) throw new HttpError(404, "STATION_HANDOVER_UNKNOWN", "Transmission introuvable.");
  return updated;
}

/* -------------------------------------------------------------------------- */
/* Exécution active de l'opérateur — LECTURE du moteur #274                   */
/* -------------------------------------------------------------------------- */

export async function repoActiveExecutionForUser(userId: number): Promise<Record<string, unknown> | null> {
  const { rows } = await pool.query(
    `SELECT p.id, p.of_id, o.numero AS of_numero, p.operation_id, op.phase, op.designation,
            p.machine_id, m.code AS machine_code, m.name AS machine_name,
            p.activity_code, ac.label AS activity_label, ac.is_productive,
            p.start_ts, p.session_id, p.segment_index,
            floor(EXTRACT(EPOCH FROM (now() - p.start_ts)) / 60)::int AS elapsed_minutes
       FROM public.production_pointages p
       LEFT JOIN public.ordres_fabrication o ON o.id = p.of_id
       LEFT JOIN public.of_operations op ON op.id = p.operation_id
       LEFT JOIN public.machines m ON m.id = p.machine_id
       LEFT JOIN public.production_activity_categories ac ON ac.code = p.activity_code
      WHERE p.operator_user_id = $1 AND p.status = 'RUNNING'
      ORDER BY p.start_ts DESC
      LIMIT 1`,
    [userId]
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    of: { id: num(r.of_id), numero: r.of_numero },
    operation: r.operation_id
      ? { id: r.operation_id, phase: num(r.phase), designation: r.designation }
      : null,
    machine: r.machine_id ? { id: r.machine_id, code: r.machine_code, name: r.machine_name } : null,
    activity: { code: r.activity_code, label: r.activity_label ?? r.activity_code, is_productive: Boolean(r.is_productive) },
    start_ts: iso(r.start_ts),
    elapsed_minutes: num(r.elapsed_minutes),
    session_id: r.session_id,
    segment_index: num(r.segment_index),
  };
}

export { badgePepper as __badgePepperForTests, assertDeviceUsable };
