import bcrypt from "bcryptjs";
import crypto from "node:crypto";

import { resolveBlobForDownload } from "../../ged/services/ged-vault.service";
import { HttpError } from "../../../utils/httpError";
import {
  hashPortalOpaqueValue,
  hashPortalRateLimitValue,
  normalizePortalEmail,
  signPortalInvitationToken,
  signPortalResetToken,
  signPortalSession,
  stablePortalRequestHash,
  verifyPortalInvitationToken,
  verifyPortalResetToken,
} from "../domain/client-portal-security";
import * as repo from "../repository/client-portal.repository";
import type {
  ClientPortalDocumentState,
  ClientPortalIdentity,
  ClientPortalRequestMeta,
} from "../types/client-portal.types";
import type {
  AdminCreatePortalAccountInput,
  AdminCreatePortalPublicationInput,
  PortalActivateInput,
  PortalLoginInput,
  PortalPagination,
} from "../validators/client-portal.validators";
import { sendPortalAccessEmail } from "./client-portal-email.service";

const ONE_HOUR_MS = 60 * 60 * 1000;

function hashIp(ip: string | null): string | null {
  return ip ? hashPortalRateLimitValue(`ip:${ip}`) : null;
}

export function buildPortalRequestMeta(input: {
  requestId: string | null;
  ip: string | null;
  browser: string | null;
}): ClientPortalRequestMeta {
  return {
    requestId: input.requestId,
    ipHash: hashIp(input.ip),
    userAgentFamily: input.browser?.trim().slice(0, 80) || null,
  };
}

async function consumeAttempt(
  action: "LOGIN" | "ACTIVATE" | "FORGOT_PASSWORD" | "RESET_PASSWORD",
  identifier: string,
  meta: ClientPortalRequestMeta,
  limits: { identifier: number; ip: number; windowSeconds: number }
): Promise<string> {
  return repo.repoConsumePortalAuthAttempt({
    action,
    identifierHash: hashPortalRateLimitValue(`${action}:${identifier}`),
    ipHash: meta.ipHash,
    identifierLimit: limits.identifier,
    ipLimit: limits.ip,
    windowSeconds: limits.windowSeconds,
  });
}

export async function createPortalAccountByAdmin(input: {
  actorId: number;
  idempotencyKey: string;
  body: AdminCreatePortalAccountInput;
  meta: ClientPortalRequestMeta;
}) {
  const emailNormalized = normalizePortalEmail(input.body.email);
  const passwordHash = await bcrypt.hash(crypto.randomBytes(48).toString("base64url"), 12);
  const requestHash = stablePortalRequestHash({
    actor_id: input.actorId,
    client_id: input.body.client_id,
    email_normalized: emailNormalized,
    display_name: input.body.display_name,
  });
  return repo.repoCreatePortalAccount({
    actorId: input.actorId,
    idempotencyKey: input.idempotencyKey,
    requestHash,
    clientId: input.body.client_id,
    email: input.body.email.trim(),
    emailNormalized,
    displayName: input.body.display_name.trim(),
    passwordHash,
    meta: input.meta,
  });
}

export async function createPortalInvitationByAdmin(input: {
  actorId: number;
  accountId: string;
  idempotencyKey: string;
  meta: ClientPortalRequestMeta;
}) {
  const tokenId = crypto.randomUUID();
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + 24 * ONE_HOUR_MS);
  const tokenCandidate = signPortalInvitationToken({
    tokenId,
    accountId: input.accountId,
    createdAt: createdAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  });
  const result = await repo.repoCreatePortalInvitation({
    actorId: input.actorId,
    accountId: input.accountId,
    tokenId,
    tokenHash: hashPortalOpaqueValue(tokenCandidate),
    createdAt: createdAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    idempotencyKey: input.idempotencyKey,
    requestHash: stablePortalRequestHash({ actor_id: input.actorId, account_id: input.accountId }),
    meta: input.meta,
  });
  const tokenRow = result.token;
  const replayToken = signPortalInvitationToken({
    tokenId: String(tokenRow.token_id),
    accountId: String(tokenRow.account_id),
    createdAt: String(tokenRow.created_at),
    expiresAt: String(tokenRow.expires_at),
  });
  if (hashPortalOpaqueValue(replayToken) !== hashPortalOpaqueValue(tokenCandidate) && !result.replayed) {
    throw new HttpError(409, "CLIENT_PORTAL_INVITATION_REPLAY", "Le lien d'invitation ne peut pas être reproduit.");
  }
  const path = `/portal/activate?token=${encodeURIComponent(replayToken)}`;
  const delivery = await sendPortalAccessEmail({
    to: String(tokenRow.email),
    displayName: String(tokenRow.display_name),
    path,
    kind: "INVITATION",
    expiresMinutes: 24 * 60,
    idempotencyKey: input.idempotencyKey,
  });
  return {
    invitation: {
      account_id: String(tokenRow.account_id),
      expires_at: String(tokenRow.expires_at),
      activation_path: path,
      token: replayToken,
      delivery,
    },
    replayed: result.replayed,
  };
}

export async function activatePortalAccount(body: PortalActivateInput, meta: ClientPortalRequestMeta) {
  const claims = verifyPortalInvitationToken(body.token);
  const attemptId = await consumeAttempt("ACTIVATE", claims.tokenId, meta, {
    identifier: 8,
    ip: 30,
    windowSeconds: 60 * 60,
  });
  const passwordHash = await bcrypt.hash(body.password, 12);
  const result = await repo.repoActivatePortalAccount({
    tokenId: claims.tokenId,
    accountId: claims.accountId,
    tokenHash: hashPortalOpaqueValue(body.token),
    passwordHash,
    meta,
  });
  await repo.repoMarkPortalAuthAttemptSuccess(attemptId);
  return result;
}

export async function loginPortal(body: PortalLoginInput, meta: ClientPortalRequestMeta) {
  const emailNormalized = normalizePortalEmail(body.email);
  const attemptId = await consumeAttempt("LOGIN", emailNormalized, meta, {
    identifier: 5,
    ip: 30,
    windowSeconds: 15 * 60,
  });
  const account = await repo.repoFindPortalAccountByEmail(emailNormalized);
  const hash = account?.password_hash ?? await bcrypt.hash("client-portal-nonexistent-account", 12);
  const validPassword = await bcrypt.compare(body.password, hash);
  if (!account || !validPassword || account.status !== "ACTIVE") {
    throw new HttpError(401, "CLIENT_PORTAL_LOGIN_INVALID", "Email ou mot de passe incorrect.");
  }
  await repo.repoMarkPortalAuthAttemptSuccess(attemptId);
  await repo.repoRecordPortalLogin(account, meta);
  const identity: ClientPortalIdentity = {
    accountId: account.id,
    clientId: account.client_id,
    sessionEpoch: account.session_epoch,
  };
  return {
    token: signPortalSession(identity),
    expires_in_seconds: 15 * 60,
    account: {
      id: account.id,
      display_name: account.display_name,
      client_id: account.client_id,
      company_name: account.company_name,
    },
  };
}

export async function requestPortalPasswordReset(email: string, meta: ClientPortalRequestMeta) {
  const emailNormalized = normalizePortalEmail(email);
  const attemptId = await consumeAttempt("FORGOT_PASSWORD", emailNormalized, meta, {
    identifier: 4,
    ip: 20,
    windowSeconds: 60 * 60,
  });
  const account = await repo.repoFindPortalAccountByEmail(emailNormalized);
  if (account && account.status === "ACTIVE") {
    const tokenId = crypto.randomUUID();
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + ONE_HOUR_MS);
    const token = signPortalResetToken({
      tokenId,
      accountId: account.id,
      createdAt: createdAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    });
    await repo.repoCreatePortalResetToken({
      accountId: account.id,
      tokenId,
      tokenHash: hashPortalOpaqueValue(token),
      createdAt: createdAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      meta,
    });
    await sendPortalAccessEmail({
      to: account.email,
      displayName: account.display_name,
      path: `/portal/reset-password?token=${encodeURIComponent(token)}`,
      kind: "PASSWORD_RESET",
      expiresMinutes: 60,
      idempotencyKey: tokenId,
    });
  }
  await repo.repoMarkPortalAuthAttemptSuccess(attemptId);
  return { accepted: true };
}

export async function resetPortalPassword(body: PortalActivateInput, meta: ClientPortalRequestMeta) {
  const claims = verifyPortalResetToken(body.token);
  const attemptId = await consumeAttempt("RESET_PASSWORD", claims.tokenId, meta, {
    identifier: 8,
    ip: 30,
    windowSeconds: 60 * 60,
  });
  const passwordHash = await bcrypt.hash(body.password, 12);
  const result = await repo.repoResetPortalPassword({
    tokenId: claims.tokenId,
    accountId: claims.accountId,
    tokenHash: hashPortalOpaqueValue(body.token),
    passwordHash,
    meta,
  });
  await repo.repoMarkPortalAuthAttemptSuccess(attemptId);
  return result;
}

export async function setPortalAccountStatusByAdmin(input: {
  actorId: number;
  accountId: string;
  status: "ACTIVE" | "SUSPENDED" | "REVOKED";
  reason: string;
  meta: ClientPortalRequestMeta;
}) {
  return repo.repoSetPortalAccountStatus(input);
}

export function portalDocumentState(row: repo.PortalDocumentRow, now = Date.now()): ClientPortalDocumentState {
  if (row.revoked_at) return "REVOKED";
  if (row.expires_at && new Date(row.expires_at).getTime() <= now) return "EXPIRED";
  if (row.document_archived_at) return "UNAVAILABLE";
  if (row.current_version_id !== row.version_id || row.version_status !== "APPLICABLE") return "REPLACED";
  if (row.scan_status === "infected" || row.quarantine_status === "quarantined") return "QUARANTINED";
  if (row.scan_status === "pending" || row.quarantine_status === "pending") return "PENDING_SCAN";
  if (row.scan_status === "clean" && row.quarantine_status === "released") return "AVAILABLE";
  return "UNAVAILABLE";
}

function sourceMeta(freshnessAt: string | null) {
  return {
    source: "CERP PostgreSQL — projection portail dédiée",
    freshness_at: freshnessAt,
    reliability: "SYSTEM_OF_RECORD" as const,
  };
}

export async function getPortalProfile(identity: ClientPortalIdentity) {
  const profile = await repo.repoGetPortalProfile(identity);
  if (!profile) throw new HttpError(404, "CLIENT_PORTAL_ACCOUNT_NOT_FOUND", "Compte portail introuvable.");
  return { data: profile, meta: sourceMeta(new Date().toISOString()) };
}

async function listPortalProjection(
  identity: ClientPortalIdentity,
  pagination: PortalPagination,
  loader: (identity: ClientPortalIdentity, page: number, pageSize: number) => Promise<{ items: unknown[]; total: number }>
) {
  const result = await loader(identity, pagination.page, pagination.pageSize);
  const freshness = result.items.reduce<string | null>((latest, item) => {
    if (typeof item !== "object" || item === null || !("updated_at" in item)) return latest;
    const value = (item as { updated_at?: unknown }).updated_at;
    if (typeof value !== "string") return latest;
    return latest === null || value > latest ? value : latest;
  }, null);
  return {
    data: result.items,
    pagination: { ...pagination, total: result.total },
    meta: sourceMeta(freshness),
  };
}

export const listPortalOrders = (identity: ClientPortalIdentity, pagination: PortalPagination) =>
  listPortalProjection(identity, pagination, repo.repoListPortalOrders);

export const listPortalDeliveries = (identity: ClientPortalIdentity, pagination: PortalPagination) =>
  listPortalProjection(identity, pagination, repo.repoListPortalDeliveries);

export const listPortalInvoices = (identity: ClientPortalIdentity, pagination: PortalPagination) =>
  listPortalProjection(identity, pagination, repo.repoListPortalInvoices);

export async function listPortalDocuments(identity: ClientPortalIdentity) {
  const rows = await repo.repoListPortalDocuments(identity);
  return {
    data: rows.map((row) => ({
      id: row.id,
      code: row.code,
      title: row.title,
      version_number: row.version_number,
      original_name: row.original_name,
      mime_type: row.mime_type,
      size_bytes: row.size_bytes,
      sha256: row.sha256,
      state: portalDocumentState(row),
      acknowledgement_required: row.acknowledgement_required,
      acknowledged_at: row.acknowledged_at,
      expires_at: row.expires_at,
      published_at: row.published_at,
      antivirus: {
        status: row.scan_status ?? "untracked",
        quarantine_status: row.quarantine_status ?? "untracked",
        freshness_at: row.scanned_at,
        reliability: row.scan_status ? "MEASURED" : "UNAVAILABLE",
      },
    })),
    meta: sourceMeta(rows.reduce<string | null>((latest, row) => latest === null || row.published_at > latest ? row.published_at : latest, null)),
  };
}

export async function getPortalDocumentDownload(identity: ClientPortalIdentity, publicationId: string) {
  const row = await repo.repoGetPortalDocumentDownload(identity, publicationId);
  if (!row) throw new HttpError(404, "CLIENT_PORTAL_DOCUMENT_NOT_FOUND", "Document introuvable.");
  const state = portalDocumentState(row);
  if (state !== "AVAILABLE") {
    throw new HttpError(409, `CLIENT_PORTAL_DOCUMENT_${state}`, "Ce document n'est pas disponible au téléchargement.");
  }
  if (!row.storage_key) throw new HttpError(503, "CLIENT_PORTAL_DOCUMENT_STORAGE", "Stockage documentaire indisponible.");
  const resolved = await resolveBlobForDownload(row.storage_key);
  return {
    file_path: resolved.file_path,
    allowed_root: resolved.allowed_root,
    filename: row.original_name,
    mime_type: row.mime_type,
    sha256: row.sha256,
    size_bytes: row.size_bytes,
  };
}

export async function acknowledgePortalDocument(
  identity: ClientPortalIdentity,
  publicationId: string,
  meta: ClientPortalRequestMeta
) {
  const row = await repo.repoGetPortalDocumentDownload(identity, publicationId);
  if (!row) throw new HttpError(404, "CLIENT_PORTAL_DOCUMENT_NOT_FOUND", "Document introuvable.");
  return repo.repoAcknowledgePortalDocument({
    identity,
    publicationId,
    state: portalDocumentState(row),
    meta,
  });
}

export async function createPortalPublicationByAdmin(input: {
  actorId: number;
  idempotencyKey: string;
  body: AdminCreatePortalPublicationInput;
  meta: ClientPortalRequestMeta;
}) {
  return repo.repoCreatePortalPublication({
    actorId: input.actorId,
    idempotencyKey: input.idempotencyKey,
    requestHash: stablePortalRequestHash({ actor_id: input.actorId, ...input.body }),
    clientId: input.body.client_id,
    versionId: input.body.version_id,
    title: input.body.title ?? null,
    expiresAt: input.body.expires_at ?? null,
    acknowledgementRequired: input.body.acknowledgement_required,
    meta: input.meta,
  });
}

export { repo };

