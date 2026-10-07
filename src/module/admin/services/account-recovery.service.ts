import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import pool from "../../../config/database";
import { withRealtimeOutboxTransaction } from "../../../shared/realtime/realtime-outbox-transaction";
import { revokeUserRealtimeSessions } from "../../../sockets/sockeServer";
import { HttpError } from "../../../utils/httpError";
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository";
import { updateUserPassword } from "../../auth/repository/auth.repository";
import { repoInsertPasswordReset } from "../../auth/repository/password-reset.repository";
import type { MfaAuditMeta } from "../../auth/services/mfa.service";
import { lockRecoveryAccounts, findRecoveryReplay, invalidateAccountRecoveryCredentials, insertAccountRecovery, findRecoveryCommitHash, isAccountRecoveryEnabled, type RecoveryRow } from "../repository/account-recovery.repository";
export type AccountRecoveryInput = {
    userId: number;
    actorUserId: number;
    actorSessionEpoch: number;
    actorFactorId: string;
    actorFactorVersion: number;
    idempotencyKey: string;
    reason: string;
    meta: MfaAuditMeta;
};
function signRecoveryToken(row: Pick<RecoveryRow, "id" | "user_id" | "created_at" | "expires_at">): string {
    const key = process.env.JWT_SECRET?.trim();
    if (!key)
        throw new Error("JWT_SECRET is required for account recovery");
    const payload = Buffer.from(JSON.stringify({
        purpose: "cerp-account-recovery-v1", id: row.id, userId: row.user_id,
        createdAt: row.created_at.toISOString(), expiresAt: row.expires_at.toISOString(),
    })).toString("base64url");
    // Keep the opaque token within the existing reset endpoint's 256-character
    // contract. The signed payload is reconstructed from durable recovery data.
    return `ar1.${row.id}.${crypto.createHmac("sha256", key).update(payload).digest("base64url")}`;
}
const hash = (value: string) => crypto.createHash("sha256").update(value).digest("hex");
export async function recoverAccountBySuperadmin(input: AccountRecoveryInput) {
    if (input.userId === input.actorUserId) {
        throw new HttpError(409, "SELF_RECOVERY_FORBIDDEN", "La récupération de votre propre compte doit passer par la procédure de secours.");
    }
    const requestHash = hash(JSON.stringify({ actorId: input.actorUserId, userId: input.userId, reason: input.reason }));
    const createdAt = new Date();
    const candidate = {
        id: crypto.randomUUID(), user_id: input.userId, created_at: createdAt,
        expires_at: new Date(createdAt.getTime() + 15 * 60000),
    };
    const tokenHash = hash(signRecoveryToken(candidate));
    // Neither the administrator nor the user knows this invalidating password.
    const passwordHash = await bcrypt.hash(crypto.randomBytes(48).toString("base64url"), 12);
    const client = await pool.connect();
    const result = await withRealtimeOutboxTransaction(client, async (tx) => {
        if (!await isAccountRecoveryEnabled(tx)) {
            throw new HttpError(503, "ACCOUNT_RECOVERY_UNAVAILABLE", "La récupération est temporairement indisponible. Réessayez après la mise à jour des services.");
        }
        const users = await lockRecoveryAccounts(tx, input.actorUserId, input.userId, input.idempotencyKey);
        const actor = users.find(row => row.id === input.actorUserId);
        if (!actor?.is_superadmin || actor.status !== "Active" || actor.session_epoch !== input.actorSessionEpoch
            || actor.factor_id !== input.actorFactorId || actor.factor_version !== input.actorFactorVersion) {
            throw new HttpError(403, "RECOVERY_SUPERADMIN_REQUIRED", "Une session superadministrateur avec MFA active est requise.");
        }
        const target = users.find(row => row.id === input.userId);
        if (!target)
            throw new HttpError(404, "USER_NOT_FOUND", "Compte introuvable.");
        if (target.status !== "Active")
            throw new HttpError(409, "RECOVERY_ACCOUNT_NOT_ACTIVE", "Le compte doit être actif ; cette action ne réactive pas un compte désactivé.");
        const existing = await findRecoveryReplay(tx, input.actorUserId, input.idempotencyKey);
        if (existing) {
            if (existing.request_hash !== requestHash)
                throw new HttpError(409, "IDEMPOTENCY_CONFLICT", "Cette demande de récupération a déjà été utilisée avec un autre contenu.");
            return { row: existing, replayed: true };
        }
        const revoked = await invalidateAccountRecoveryCredentials(tx, input.userId, input.actorUserId);
        await updateUserPassword({ userId: input.userId, passwordHash, tx });
        const resetId = crypto.randomUUID();
        await repoInsertPasswordReset({ id: resetId, user_id: input.userId, token_hash: tokenHash, expires_at: candidate.expires_at, tx });
        const inserted = await insertAccountRecovery(tx, { ...candidate, actor_user_id: input.actorUserId,
            idempotency_key: input.idempotencyKey, request_hash: requestHash, reason: input.reason, reset_id: resetId, token_hash: tokenHash });
        await repoInsertAuditLog({ user_id: input.actorUserId,
            body: { event_type: "ACTION", action: "ADMIN_ACCOUNT_RECOVERY_STARTED", page_key: "administration-acces", entity_type: "user", entity_id: String(input.userId), path: input.meta.path,
                details: { recovery_id: candidate.id, reason: input.reason, identity_confirmed: true, revoked_factors: revoked.factors,
                    revoked_pins: revoked.pins, revoked_badges: revoked.badges, revoked_station_sessions: revoked.stationSessions,
                    password_invalidated: true, mfa_reenrollment_required: true } },
            ip: input.meta.ip, user_agent: input.meta.user_agent, device_type: input.meta.device_type, os: input.meta.os, browser: input.meta.browser, tx,
        });
        return { row: inserted, replayed: false };
    }, { reconcileCommit: async (verifier, value) => {
            const committedHash = await findRecoveryCommitHash(verifier, value.row.id);
            return committedHash === requestHash ? "committed" : committedHash === null ? "not_committed" : "unknown";
        } });
    if (!result.replayed)
        await revokeUserRealtimeSessions(input.userId, { durable: false }).catch(() => undefined);
    const row = result.row;
    const usable = !row.superseded_at && !row.completed_at && row.reset_usable && row.expires_at.getTime() > Date.now();
    const token = usable ? signRecoveryToken(row) : null;
    if (token && hash(token) !== row.token_hash)
        throw new HttpError(409, "RECOVERY_LINK_UNAVAILABLE", "Le lien ne peut pas être rejoué ; émettez une nouvelle récupération après vérification d'identité.");
    return { recovery_id: row.id, user_id: row.user_id, expires_at: row.expires_at.toISOString(), replayed: result.replayed,
        reset_path: token ? `/reset-password?token=${encodeURIComponent(token)}` : null,
        state: row.completed_at ? "COMPLETED" : row.superseded_at ? "SUPERSEDED" : row.expires_at.getTime() <= Date.now() ? "EXPIRED" : row.reset_usable ? "PASSWORD_REQUIRED" : "MFA_REQUIRED",
    };
}
