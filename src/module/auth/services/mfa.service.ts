import bcrypt from "bcryptjs";
import bwipjs from "bwip-js";
import type { PoolClient } from "pg";

import pool from "../../../config/database";
import { withRealtimeOutboxTransaction } from "../../../shared/realtime/realtime-outbox-transaction";
import { bumpRealtimeSessionEpoch } from "../../../shared/realtime/realtime-control-plane";
import { ApiError } from "../../../utils/apiError";
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository";
import {
  buildOtpAuthUri,
  decryptMfaSecret,
  encryptMfaSecret,
  generateRecoveryCodes,
  generateTotpSecret,
  hashChallengeToken,
  hashRecoveryCode,
  opaqueChallengeToken,
  verifyTotp,
} from "../domain/mfa";
import { issueSessionToken, type MfaAssurance, type SessionIdentity } from "../domain/session-token";
import { insertLoginLog } from "../repository/authLog.repository";

const CHALLENGE_TTL_MS = 5 * 60_000;
const ENROLLMENT_TTL_MS = 15 * 60_000;
const LOCK_MS = 15 * 60_000;
const MAX_ATTEMPTS = 5;

export type MfaAuditMeta = {
  ip: string | null;
  user_agent: string | null;
  device_type: string | null;
  os: string | null;
  browser: string | null;
  path: string;
  request_id?: string | null;
};

type FactorRow = {
  id: string;
  user_id: number;
  state: "PENDING" | "ACTIVE" | "REVOKED";
  encrypted_secret: Buffer;
  encryption_iv: Buffer;
  encryption_tag: Buffer;
  key_id: string;
  version: number;
  last_verified_step: string | null;
  failed_attempts: number;
  locked_until: Date | null;
  pending_expires_at: Date | null;
  enrolled_at: Date | null;
};

type ChallengeRow = {
  id: string;
  user_id: number;
  factor_id: string;
  purpose: "LOGIN" | "ENROLL" | "REPLACE";
  session_epoch: number;
  attempt_count: number;
  locked_until: Date | null;
  expires_at: Date;
  used_at: Date | null;
  username: string;
  email: string | null;
  role: string;
  roles: string[];
  status: string;
  is_superadmin: boolean;
  realtime_session_epoch: string;
  factor_state: "PENDING" | "ACTIVE" | "REVOKED";
  encrypted_secret: Buffer;
  encryption_iv: Buffer;
  encryption_tag: Buffer;
  key_id: string;
  factor_version: number;
  last_verified_step: string | null;
  factor_failed_attempts: number;
  factor_locked_until: Date | null;
  pending_expires_at: Date | null;
};

type UserMfaRow = SessionIdentity & {
  password: string;
  status: string;
  is_superadmin: boolean;
};

function asSecret(factor: Pick<FactorRow, "encrypted_secret" | "encryption_iv" | "encryption_tag" | "key_id">): string {
  return decryptMfaSecret({
    encrypted: factor.encrypted_secret,
    iv: factor.encryption_iv,
    tag: factor.encryption_tag,
    keyId: factor.key_id,
  });
}

async function audit(tx: PoolClient, userId: number, action: string, meta: MfaAuditMeta, details: Record<string, unknown>) {
  await repoInsertAuditLog({
    user_id: userId,
    body: {
      event_type: "ACTION",
      action,
      page_key: "auth-mfa",
      entity_type: "user_mfa_factor",
      entity_id: String(userId),
      path: meta.path,
      details: { ...details, request_id: meta.request_id ?? null },
    },
    ip: meta.ip,
    user_agent: meta.user_agent,
    device_type: meta.device_type,
    os: meta.os,
    browser: meta.browser,
    tx,
  });
}

async function qrDataUrl(uri: string): Promise<string> {
  const png = await bwipjs.toBuffer({
    bcid: "qrcode",
    text: uri,
    scale: 4,
    paddingwidth: 4,
    paddingheight: 4,
    includetext: false,
  });
  return `data:image/png;base64,${Buffer.from(png).toString("base64")}`;
}

async function loadFactor(tx: PoolClient, userId: number, state: "ACTIVE" | "PENDING", forUpdate = false) {
  const { rows } = await tx.query<FactorRow>(
    `SELECT * FROM public.user_mfa_factors
      WHERE user_id = $1 AND state = $2
      ORDER BY created_at DESC LIMIT 1${forUpdate ? " FOR UPDATE" : ""}`,
    [userId, state],
  );
  return rows[0] ?? null;
}

async function loadUser(tx: PoolClient, userId: number, forUpdate = false): Promise<UserMfaRow | null> {
  const { rows } = await tx.query<UserMfaRow>(
    `SELECT u.id, u.username, u.email, u.password, u.role, u.status, u.is_superadmin,
            COALESCE(rse.session_epoch, 0)::text AS realtime_session_epoch,
            COALESCE((SELECT array_agg(ura.role_key ORDER BY (ura.role_key = u.role) DESC, ura.role_key)
                        FROM public.user_role_assignments ura WHERE ura.user_id = u.id),
                     ARRAY[u.role]::text[]) AS roles
       FROM public.users u
       LEFT JOIN public.realtime_session_epochs rse ON rse.user_id = u.id
      WHERE u.id = $1${forUpdate ? " FOR UPDATE OF u" : ""}`,
    [userId],
  );
  return rows[0] ?? null;
}

async function insertChallenge(
  tx: PoolClient,
  params: { userId: number; factorId: string; purpose: ChallengeRow["purpose"]; sessionEpoch: number },
) {
  const opaque = opaqueChallengeToken();
  const ttl = params.purpose === "LOGIN" ? CHALLENGE_TTL_MS : ENROLLMENT_TTL_MS;
  await tx.query(
    `UPDATE public.auth_mfa_challenges SET used_at = now()
      WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL`,
    [params.userId, params.purpose],
  );
  await tx.query(
    `INSERT INTO public.auth_mfa_challenges
       (user_id, factor_id, purpose, token_hash, session_epoch, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [params.userId, params.factorId, params.purpose, opaque.hash, params.sessionEpoch, new Date(Date.now() + ttl)],
  );
  return opaque.token;
}

async function createPendingFactor(tx: PoolClient, user: UserMfaRow): Promise<{ factor: FactorRow; secret: string }> {
  const existing = await loadFactor(tx, user.id, "PENDING", true);
  if (existing && existing.pending_expires_at && existing.pending_expires_at.getTime() > Date.now()) {
    return { factor: existing, secret: asSecret(existing) };
  }
  if (existing) {
    await tx.query(
      `UPDATE public.user_mfa_factors SET state='REVOKED', revoked_at=now(), updated_at=now()
        WHERE id=$1`,
      [existing.id],
    );
  }
  const active = await loadFactor(tx, user.id, "ACTIVE", true);
  const secret = generateTotpSecret();
  const encrypted = encryptMfaSecret(secret);
  const { rows } = await tx.query<FactorRow>(
    `INSERT INTO public.user_mfa_factors
       (user_id, encrypted_secret, encryption_iv, encryption_tag, key_id, version, pending_expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING *`,
    [
      user.id,
      encrypted.encrypted,
      encrypted.iv,
      encrypted.tag,
      encrypted.keyId,
      (active?.version ?? 0) + 1,
      new Date(Date.now() + ENROLLMENT_TTL_MS),
    ],
  );
  return { factor: rows[0]!, secret };
}

export type PasswordLoginUser = UserMfaRow;

export async function beginMfaAfterPassword(user: PasswordLoginUser, meta: MfaAuditMeta) {
  const client = await pool.connect();
  const result = await withRealtimeOutboxTransaction(client, async (tx) => {
    const active = await loadFactor(tx, user.id, "ACTIVE", true);
    const sessionEpoch = Number.parseInt(String(user.realtime_session_epoch ?? "0"), 10) || 0;
    if (active) {
      const challenge = await insertChallenge(tx, {
        userId: user.id,
        factorId: active.id,
        purpose: "LOGIN",
        sessionEpoch,
      });
      return { kind: "verify" as const, challenge };
    }
    if (!user.is_superadmin) return { kind: "none" as const };
    const { factor, secret } = await createPendingFactor(tx, user);
    const challenge = await insertChallenge(tx, {
      userId: user.id,
      factorId: factor.id,
      purpose: "ENROLL",
      sessionEpoch,
    });
    await audit(tx, user.id, "AUTH_MFA_ENROLLMENT_STARTED", meta, {
      factor_id: factor.id,
      factor_version: factor.version,
      method: "TOTP",
    });
    return { kind: "enroll" as const, challenge, secret };
  });

  if (result.kind === "none") return null;
  if (result.kind === "verify") {
    return {
      status: "mfa_required" as const,
      challenge_token: result.challenge,
      challenge_expires_in_seconds: CHALLENGE_TTL_MS / 1000,
      methods: ["totp", "recovery_code"] as const,
    };
  }
  const uri = buildOtpAuthUri({ username: user.username, secret: result.secret });
  return {
    status: "mfa_enrollment_required" as const,
    challenge_token: result.challenge,
    challenge_expires_in_seconds: ENROLLMENT_TTL_MS / 1000,
    totp: {
      issuer: "CERP+",
      account: user.username,
      secret: result.secret,
      otpauth_uri: uri,
      qr_data_url: await qrDataUrl(uri),
      digits: 6,
      period_seconds: 30,
      algorithm: "SHA1" as const,
    },
  };
}

async function loadChallengeForUpdate(tx: PoolClient, tokenHash: string): Promise<ChallengeRow | null> {
  const { rows } = await tx.query<ChallengeRow>(
    `SELECT c.*,
            u.username, u.email, u.role, u.status, u.is_superadmin,
            COALESCE(rse.session_epoch, 0)::text AS realtime_session_epoch,
            COALESCE((SELECT array_agg(ura.role_key ORDER BY (ura.role_key = u.role) DESC, ura.role_key)
                        FROM public.user_role_assignments ura WHERE ura.user_id = u.id),
                     ARRAY[u.role]::text[]) AS roles,
            f.state AS factor_state, f.encrypted_secret, f.encryption_iv, f.encryption_tag,
            f.key_id, f.version AS factor_version, f.last_verified_step,
            f.failed_attempts AS factor_failed_attempts, f.locked_until AS factor_locked_until,
            f.pending_expires_at
       FROM public.auth_mfa_challenges c
       JOIN public.users u ON u.id = c.user_id
       JOIN public.user_mfa_factors f ON f.id = c.factor_id
       LEFT JOIN public.realtime_session_epochs rse ON rse.user_id = u.id
      WHERE c.token_hash = $1
      FOR UPDATE OF c, f, u`,
    [tokenHash],
  );
  return rows[0] ?? null;
}

function challengeFailure(row: ChallengeRow): { code: string; message: string } | null {
  const now = Date.now();
  if (row.used_at) return { code: "MFA_CHALLENGE_USED", message: "Ce défi MFA a déjà été utilisé." };
  if (row.expires_at.getTime() <= now) return { code: "MFA_CHALLENGE_EXPIRED", message: "Le défi MFA a expiré." };
  if (row.locked_until && row.locked_until.getTime() > now) return { code: "MFA_LOCKED", message: "Le facteur MFA est temporairement verrouillé." };
  if (row.factor_locked_until && row.factor_locked_until.getTime() > now) return { code: "MFA_LOCKED", message: "Le facteur MFA est temporairement verrouillé." };
  if (row.status !== "Active") return { code: "AUTH_INVALID", message: "Identifiants invalides" };
  if (row.session_epoch !== Number.parseInt(row.realtime_session_epoch, 10)) {
    return { code: "MFA_CHALLENGE_STALE", message: "La session a changé. Reconnectez-vous." };
  }
  if (row.purpose === "LOGIN" && row.factor_state !== "ACTIVE") return { code: "MFA_FACTOR_INVALID", message: "Le facteur MFA n'est plus actif." };
  if (row.purpose !== "LOGIN" && (row.factor_state !== "PENDING" || !row.pending_expires_at || row.pending_expires_at.getTime() <= now)) {
    return { code: "MFA_ENROLLMENT_EXPIRED", message: "L'enrôlement MFA a expiré." };
  }
  return null;
}

async function consumeRecoveryCode(tx: PoolClient, factorId: string, code: string): Promise<boolean> {
  const hash = hashRecoveryCode(code);
  const { rowCount } = await tx.query(
    `UPDATE public.user_mfa_recovery_codes SET used_at=now()
      WHERE factor_id=$1 AND code_hash=$2 AND used_at IS NULL`,
    [factorId, hash],
  );
  return (rowCount ?? 0) === 1;
}

async function recordFailedAttempt(tx: PoolClient, row: ChallengeRow, meta: MfaAuditMeta) {
  const next = Math.max(row.attempt_count, row.factor_failed_attempts) + 1;
  const lockedUntil = next >= MAX_ATTEMPTS ? new Date(Date.now() + LOCK_MS) : null;
  await tx.query(
    `UPDATE public.auth_mfa_challenges
        SET attempt_count=attempt_count+1, locked_until=COALESCE($2, locked_until)
      WHERE id=$1`,
    [row.id, lockedUntil],
  );
  await tx.query(
    `UPDATE public.user_mfa_factors
        SET failed_attempts=failed_attempts+1, locked_until=COALESCE($2, locked_until), updated_at=now()
      WHERE id=$1`,
    [row.factor_id, lockedUntil],
  );
  await audit(tx, row.user_id, lockedUntil ? "AUTH_MFA_LOCKED" : "AUTH_MFA_VERIFICATION_FAILED", meta, {
    factor_id: row.factor_id,
    purpose: row.purpose,
    attempt: next,
    locked_until: lockedUntil?.toISOString() ?? null,
  });
}

async function recordActiveFactorFailedAttempt(
  tx: PoolClient,
  factor: FactorRow,
  userId: number,
  meta: MfaAuditMeta,
) {
  const next = factor.failed_attempts + 1;
  const lockedUntil = next >= MAX_ATTEMPTS ? new Date(Date.now() + LOCK_MS) : null;
  await tx.query(
    `UPDATE public.user_mfa_factors
        SET failed_attempts=failed_attempts+1, locked_until=COALESCE($2, locked_until), updated_at=now()
      WHERE id=$1`,
    [factor.id, lockedUntil],
  );
  await audit(tx, userId, lockedUntil ? "AUTH_MFA_LOCKED" : "AUTH_MFA_VERIFICATION_FAILED", meta, {
    factor_id: factor.id,
    purpose: "STEP_UP",
    attempt: next,
    locked_until: lockedUntil?.toISOString() ?? null,
  });
}

async function insertRecoveryCodes(tx: PoolClient, factorId: string): Promise<string[]> {
  const codes = generateRecoveryCodes();
  await tx.query(`DELETE FROM public.user_mfa_recovery_codes WHERE factor_id=$1`, [factorId]);
  for (const code of codes) {
    await tx.query(
      `INSERT INTO public.user_mfa_recovery_codes(factor_id, code_hash) VALUES ($1,$2)`,
      [factorId, hashRecoveryCode(code)],
    );
  }
  return codes;
}

export async function verifyMfaChallenge(challengeToken: string, code: string, meta: MfaAuditMeta) {
  const client = await pool.connect();
  const outcome = await withRealtimeOutboxTransaction(client, async (tx) => {
    const row = await loadChallengeForUpdate(tx, hashChallengeToken(challengeToken));
    if (!row) return { ok: false as const, status: 400, code: "MFA_CHALLENGE_INVALID", message: "Défi MFA invalide." };
    const failure = challengeFailure(row);
    if (failure) return { ok: false as const, status: failure.code === "MFA_LOCKED" ? 423 : 400, ...failure };

    const secret = asSecret(row);
    let method: MfaAssurance["method"] = "totp";
    const verifiedStep = verifyTotp({ secret, code });
    let valid = verifiedStep !== null;
    if (valid && row.last_verified_step !== null && verifiedStep! <= Number.parseInt(row.last_verified_step, 10)) {
      valid = false;
    }
    if (!valid && row.purpose === "LOGIN") {
      valid = await consumeRecoveryCode(tx, row.factor_id, code);
      if (valid) method = "recovery_code";
    }
    if (!valid) {
      await recordFailedAttempt(tx, row, meta);
      return { ok: false as const, status: 401, code: "MFA_CODE_INVALID", message: "Code MFA invalide." };
    }

    let recoveryCodes: string[] | undefined;
    if (row.purpose !== "LOGIN") {
      await tx.query(
        `UPDATE public.user_mfa_factors
            SET state='REVOKED', revoked_at=now(), updated_at=now()
          WHERE user_id=$1 AND state='ACTIVE' AND id<>$2`,
        [row.user_id, row.factor_id],
      );
      await tx.query(
        `UPDATE public.user_mfa_factors
            SET state='ACTIVE', enrolled_at=now(), pending_expires_at=NULL,
                last_verified_step=$2, failed_attempts=0, locked_until=NULL, updated_at=now()
          WHERE id=$1`,
        [row.factor_id, verifiedStep],
      );
      recoveryCodes = await insertRecoveryCodes(tx, row.factor_id);
      await bumpRealtimeSessionEpoch(tx, row.user_id);
      await audit(tx, row.user_id, row.purpose === "REPLACE" ? "AUTH_MFA_FACTOR_REPLACED" : "AUTH_MFA_ENROLLED", meta, {
        factor_id: row.factor_id,
        factor_version: row.factor_version,
        method: "TOTP",
      });
    } else {
      await tx.query(
        `UPDATE public.user_mfa_factors
            SET last_verified_step=CASE WHEN $2::bigint IS NULL THEN last_verified_step ELSE $2::bigint END,
                failed_attempts=0, locked_until=NULL, updated_at=now()
          WHERE id=$1`,
        [row.factor_id, verifiedStep],
      );
      await audit(tx, row.user_id, method === "recovery_code" ? "AUTH_MFA_RECOVERY_CODE_USED" : "AUTH_MFA_VERIFIED", meta, {
        factor_id: row.factor_id,
        factor_version: row.factor_version,
        method,
      });
    }
    await tx.query(`UPDATE public.auth_mfa_challenges SET used_at=now() WHERE id=$1`, [row.id]);
    const user = await loadUser(tx, row.user_id);
    if (!user) return { ok: false as const, status: 401, code: "AUTH_INVALID", message: "Identifiants invalides" };
    return {
      ok: true as const,
      user,
      factorId: row.factor_id,
      factorVersion: row.factor_version,
      method,
      recoveryCodes,
    };
  });

  if (!outcome.ok) throw new ApiError(outcome.status, outcome.code, outcome.message);
  await insertLoginLog({
    user_id: outcome.user.id,
    username_attempt: outcome.user.username,
    success: true,
    failure_reason: null,
    ip: meta.ip,
    user_agent: meta.user_agent,
    device_type: meta.device_type,
    os: meta.os,
    browser: meta.browser,
  });
  const assurance: MfaAssurance = {
    factorId: outcome.factorId,
    factorVersion: outcome.factorVersion,
    verifiedAt: new Date(),
    method: outcome.method,
  };
  return { ...issueSessionToken(outcome.user, assurance), recovery_codes: outcome.recoveryCodes };
}

async function verifyActiveCode(tx: PoolClient, user: UserMfaRow, code: string, meta: MfaAuditMeta) {
  const factor = await loadFactor(tx, user.id, "ACTIVE", true);
  if (!factor) return { ok: false as const, status: 409, code: "MFA_NOT_ENROLLED", message: "Aucun facteur MFA actif." };
  if (factor.locked_until && factor.locked_until.getTime() > Date.now()) {
    return { ok: false as const, status: 423, code: "MFA_LOCKED", message: "Le facteur MFA est temporairement verrouillé." };
  }
  const step = verifyTotp({ secret: asSecret(factor), code });
  let method: MfaAssurance["method"] = "totp";
  let valid = step !== null && (factor.last_verified_step === null || step > Number.parseInt(factor.last_verified_step, 10));
  if (!valid) {
    valid = await consumeRecoveryCode(tx, factor.id, code);
    if (valid) method = "recovery_code";
  }
  if (!valid) {
    await recordActiveFactorFailedAttempt(tx, factor, user.id, meta);
    return { ok: false as const, status: 401, code: "MFA_CODE_INVALID", message: "Code MFA invalide." };
  }
  await tx.query(
    `UPDATE public.user_mfa_factors
        SET last_verified_step=CASE WHEN $2::bigint IS NULL THEN last_verified_step ELSE $2::bigint END,
            failed_attempts=0, locked_until=NULL, updated_at=now()
      WHERE id=$1`,
    [factor.id, step],
  );
  return { ok: true as const, factor, method };
}

export async function getMfaStatus(userId: number) {
  const { rows } = await pool.query<{
    is_superadmin: boolean;
    factor_id: string | null;
    factor_version: number | null;
    enrolled_at: Date | null;
    locked_until: Date | null;
    recovery_codes_remaining: string;
  }>(
    `SELECT u.is_superadmin,
            f.id AS factor_id, f.version AS factor_version, f.enrolled_at, f.locked_until,
            COALESCE((SELECT count(*) FROM public.user_mfa_recovery_codes rc
                       WHERE rc.factor_id=f.id AND rc.used_at IS NULL),0)::text AS recovery_codes_remaining
       FROM public.users u
       LEFT JOIN public.user_mfa_factors f ON f.user_id=u.id AND f.state='ACTIVE'
      WHERE u.id=$1`,
    [userId],
  );
  const row = rows[0];
  if (!row) throw new ApiError(404, "USER_NOT_FOUND", "Utilisateur inconnu.");
  return {
    required: row.is_superadmin,
    enrolled: Boolean(row.factor_id),
    method: row.factor_id ? "TOTP" : null,
    factor_version: row.factor_version,
    enrolled_at: row.enrolled_at?.toISOString() ?? null,
    locked_until: row.locked_until?.toISOString() ?? null,
    recovery_codes_remaining: Number.parseInt(row.recovery_codes_remaining, 10),
  };
}

async function authenticatedMutation<T>(
  userId: number,
  password: string,
  code: string,
  meta: MfaAuditMeta,
  work: (tx: PoolClient, user: UserMfaRow, factor: FactorRow, method: MfaAssurance["method"]) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  const outcome = await withRealtimeOutboxTransaction(client, async (tx) => {
    const user = await loadUser(tx, userId, true);
    if (!user || user.status !== "Active" || !(await bcrypt.compare(password, user.password))) {
      return { ok: false as const, status: 401, code: "AUTH_INVALID", message: "Identifiants invalides" };
    }
    const verified = await verifyActiveCode(tx, user, code, meta);
    if (!verified.ok) return verified;
    return { ok: true as const, value: await work(tx, user, verified.factor, verified.method) };
  });
  if (!outcome.ok) throw new ApiError(outcome.status, outcome.code, outcome.message);
  return outcome.value;
}

export async function stepUpMfa(userId: number, code: string, meta: MfaAuditMeta) {
  const client = await pool.connect();
  const outcome = await withRealtimeOutboxTransaction(client, async (tx) => {
    const user = await loadUser(tx, userId, true);
    if (!user || user.status !== "Active") return { ok: false as const, status: 401, code: "AUTH_INVALID", message: "Identifiants invalides" };
    const verified = await verifyActiveCode(tx, user, code, meta);
    if (!verified.ok) return verified;
    await audit(tx, user.id, "AUTH_MFA_STEP_UP", meta, {
      factor_id: verified.factor.id,
      factor_version: verified.factor.version,
      method: verified.method,
    });
    return { ok: true as const, user, factor: verified.factor, method: verified.method };
  });
  if (!outcome.ok) throw new ApiError(outcome.status, outcome.code, outcome.message);
  return issueSessionToken(outcome.user, {
    factorId: outcome.factor.id,
    factorVersion: outcome.factor.version,
    verifiedAt: new Date(),
    method: outcome.method,
  });
}

export async function beginMfaReplacement(userId: number, password: string, code: string, meta: MfaAuditMeta) {
  const value = await authenticatedMutation(userId, password, code, meta, async (tx, user, _factor, method) => {
    const pending = await createPendingFactor(tx, user);
    const challenge = await insertChallenge(tx, {
      userId,
      factorId: pending.factor.id,
      purpose: "REPLACE",
      sessionEpoch: Number.parseInt(String(user.realtime_session_epoch ?? "0"), 10) || 0,
    });
    await audit(tx, userId, "AUTH_MFA_REPLACEMENT_STARTED", meta, {
      factor_id: pending.factor.id,
      factor_version: pending.factor.version,
      authorization_method: method,
    });
    return { challenge, secret: pending.secret, username: user.username };
  });
  const uri = buildOtpAuthUri({ username: value.username, secret: value.secret });
  return {
    status: "mfa_replacement_pending" as const,
    challenge_token: value.challenge,
    challenge_expires_in_seconds: ENROLLMENT_TTL_MS / 1000,
    totp: {
      issuer: "CERP+",
      account: value.username,
      secret: value.secret,
      otpauth_uri: uri,
      qr_data_url: await qrDataUrl(uri),
      digits: 6,
      period_seconds: 30,
      algorithm: "SHA1" as const,
    },
  };
}

export async function regenerateRecoveryCodes(userId: number, password: string, code: string, meta: MfaAuditMeta) {
  return authenticatedMutation(userId, password, code, meta, async (tx, user, factor, method) => {
    const recoveryCodes = await insertRecoveryCodes(tx, factor.id);
    await audit(tx, user.id, "AUTH_MFA_RECOVERY_CODES_REGENERATED", meta, {
      factor_id: factor.id,
      factor_version: factor.version,
      authorization_method: method,
      code_count: recoveryCodes.length,
    });
    return { recovery_codes: recoveryCodes };
  });
}

export async function revokeOwnMfa(userId: number, password: string, code: string, meta: MfaAuditMeta) {
  return authenticatedMutation(userId, password, code, meta, async (tx, user, factor, method) => {
    if (user.is_superadmin) {
      const { rows } = await tx.query<{ count: string }>(
        `SELECT count(DISTINCT u.id)::text AS count
           FROM public.users u
           JOIN public.user_mfa_factors f ON f.user_id=u.id AND f.state='ACTIVE'
          WHERE u.is_superadmin IS TRUE AND u.status='Active'`,
      );
      if (Number.parseInt(rows[0]?.count ?? "0", 10) <= 1) {
        throw new ApiError(
          409,
          "MFA_LAST_PRIVILEGED_FACTOR",
          "Révocation refusée pour le dernier administrateur protégé. Utilisez le runbook hors bande.",
        );
      }
    }
    await tx.query(
      `UPDATE public.user_mfa_factors SET state='REVOKED', revoked_at=now(), updated_at=now() WHERE id=$1`,
      [factor.id],
    );
    await bumpRealtimeSessionEpoch(tx, user.id);
    await audit(tx, user.id, "AUTH_MFA_REVOKED", meta, {
      factor_id: factor.id,
      factor_version: factor.version,
      authorization_method: method,
    });
    return { revoked: true };
  });
}
