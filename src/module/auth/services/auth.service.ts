import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from "node:crypto";
import { CreateUserDTO } from '../types/user.type';
import { createUser } from '../repository/auth.repository';
import { findUserByUsername } from '../repository/auth.repository';
import { findUserByUsernameOrEmail, updateUserPassword } from "../repository/auth.repository";
import { ApiError } from "../../../utils/apiError";
import { insertLoginLog } from "../repository/authLog.repository";
import pool from "../../../config/database";

import {
  repoCleanupExpiredPasswordResets,
  repoDeleteActivePasswordResetsForUser,
  repoDeleteOtherActivePasswordResetsForUser,
  repoGetPasswordResetForUpdate,
  repoInsertPasswordReset,
  repoMarkPasswordResetUsed,
} from "../repository/password-reset.repository";

import { sendPasswordResetEmail } from "./password-reset-email.service";
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository";

export const registerUser = async (data: CreateUserDTO) => {
  // 🔐 Hash du mot de passe
  const salt = await bcrypt.genSalt(10);
  const hashedPassword = await bcrypt.hash(data.password, salt);

  // 📤 Enregistrement en base
  const user = await createUser(data, hashedPassword);
  return user;
};

export const loginUser = async (
  username: string,
  password: string,
  meta: {
    ip: string | null;
    user_agent: string | null;
    device_type: string | null;
    os: string | null;
    browser: string | null;
  }
) => {
  const normalizedUsername = username.trim().toUpperCase();

  const user = await findUserByUsername(normalizedUsername);

  // Toujours message générique (sécurité)
  const invalidMsg = "Identifiants invalides";

  if (!user) {
    await insertLoginLog({
      user_id: null,
      username_attempt: normalizedUsername,
      success: false,
      failure_reason: "USER_NOT_FOUND",
      ...meta,
    });
    throw new ApiError(401, "AUTH_INVALID", invalidMsg);
  }

  const isMatch = await bcrypt.compare(password, user.password);
  if (!isMatch) {
    await insertLoginLog({
      user_id: user.id,
      username_attempt: normalizedUsername,
      success: false,
      failure_reason: "BAD_PASSWORD",
      ...meta,
    });
    throw new ApiError(401, "AUTH_INVALID", invalidMsg);
  }

  const token = jwt.sign(
    { id: user.id, username: user.username, email: user.email, role: user.role },
    process.env.JWT_SECRET as string,
    { expiresIn: "1d" }
  );

  await insertLoginLog({
    user_id: user.id,
    username_attempt: normalizedUsername,
    success: true,
    failure_reason: null,
    ...meta,
  });

  return {
    token,
    user: { id: user.id, username: user.username, email: user.email, role: user.role },
  };
};

const RESET_TOKEN_BYTES = 32;
const RESET_TOKEN_TTL_MS = 15 * 60 * 1000;

function buildFrontendBaseUrl(): string {
  const fromEnv = (process.env.FRONTEND_URL ?? "").trim();
  if (fromEnv) return fromEnv.replace(/\/+$/, "");
  if (process.env.NODE_ENV === "development") return "http://localhost:5173";
  return "";
}

function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export async function requestPasswordReset(
  usernameOrEmail: string,
  meta: {
    request_id?: string | null;
    ip: string | null;
    user_agent: string | null;
    device_type: string | null;
    os: string | null;
    browser: string | null;
  }
) {
  const user = await findUserByUsernameOrEmail(usernameOrEmail);
  if (!user || !user.email) return;

  const token = crypto.randomBytes(RESET_TOKEN_BYTES).toString("hex");
  const token_hash = sha256Hex(token);
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await repoCleanupExpiredPasswordResets({ tx: client });
    await repoDeleteActivePasswordResetsForUser({ user_id: user.id, tx: client });
    await repoInsertPasswordReset({
      id: crypto.randomUUID(),
      user_id: user.id,
      token_hash,
      expires_at: expiresAt,
      tx: client,
    });
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }

  const baseUrl = buildFrontendBaseUrl();
  const resetUrl = baseUrl ? `${baseUrl}/reset-password?token=${encodeURIComponent(token)}` : "";

  let emailDetails: { provider: "resend"; status: "sent"; id?: string } | { provider: "resend"; status: "skipped"; reason: string } | { provider: "resend"; status: "failed"; error: string } | null = null;

  if (!resetUrl) {
    emailDetails = { provider: "resend", status: "skipped", reason: "FRONTEND_URL_MISSING" };
    console.warn(
      JSON.stringify({
        type: "password_reset_email_skipped",
        requestId: meta.request_id ?? null,
        userId: user.id,
        reason: "FRONTEND_URL_MISSING",
      })
    );
  } else {
    const emailRes = await sendPasswordResetEmail({
      to: user.email,
      username: user.username,
      resetUrl,
      expiresMinutes: 15,
      request_id: meta.request_id ?? null,
    });

    if (emailRes.ok) {
      emailDetails = { provider: "resend", status: "sent", id: emailRes.id };
      console.log(
        JSON.stringify({
          type: "password_reset_email_sent",
          requestId: meta.request_id ?? null,
          userId: user.id,
          provider: "resend",
          resend_id: emailRes.id ?? null,
        })
      );
    } else if ("skipped" in emailRes && emailRes.skipped) {
      emailDetails = { provider: "resend", status: "skipped", reason: "RESEND_NOT_CONFIGURED" };
      console.warn(
        JSON.stringify({
          type: "password_reset_email_skipped",
          requestId: meta.request_id ?? null,
          userId: user.id,
          reason: "RESEND_NOT_CONFIGURED",
        })
      );
    } else {
      const err = (emailRes as { ok: false; error: string }).error;
      emailDetails = { provider: "resend", status: "failed", error: err };
      console.warn(
        JSON.stringify({
          type: "password_reset_email_failed",
          requestId: meta.request_id ?? null,
          userId: user.id,
          provider: "resend",
          error: err,
        })
      );
    }
  }

  try {
    await repoInsertAuditLog({
      user_id: user.id,
      body: {
        event_type: "ACTION",
        action: "AUTH_PASSWORD_RESET_REQUESTED",
        page_key: "auth",
        entity_type: "user",
        entity_id: String(user.id),
        path: "/api/v1/auth/forgot-password",
        details: { expires_at: expiresAt.toISOString(), email: emailDetails },
      },
      ...meta,
    });
  } catch {
    // ignore audit failures
  }
}

export async function resetPasswordWithToken(
  token: string,
  newPassword: string,
  meta: {
    ip: string | null;
    user_agent: string | null;
    device_type: string | null;
    os: string | null;
    browser: string | null;
  }
) {
  const token_hash = sha256Hex(token);
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await repoCleanupExpiredPasswordResets({ tx: client });
    const row = await repoGetPasswordResetForUpdate({ token_hash, tx: client });
    if (!row) {
      throw new ApiError(400, "RESET_TOKEN_INVALID", "Lien invalide ou expiré");
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(newPassword, salt);
    await updateUserPassword({ userId: row.user_id, passwordHash, tx: client });
    await repoMarkPasswordResetUsed({ id: row.id, tx: client });
    await repoDeleteOtherActivePasswordResetsForUser({ user_id: row.user_id, keep_id: row.id, tx: client });

    await client.query("COMMIT");

    try {
      await repoInsertAuditLog({
        user_id: row.user_id,
        body: {
          event_type: "ACTION",
          action: "AUTH_PASSWORD_RESET_COMPLETED",
          page_key: "auth",
          entity_type: "user",
          entity_id: String(row.user_id),
          path: "/api/v1/auth/reset-password",
        },
        ...meta,
      });
    } catch {
      // ignore audit failures
    }

    return;
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // ignore
    }
    throw e;
  } finally {
    client.release();
  }
}
