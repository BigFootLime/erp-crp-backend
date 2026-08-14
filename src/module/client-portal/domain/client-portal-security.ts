import crypto from "node:crypto";
import jwt from "jsonwebtoken";

import { HttpError } from "../../../utils/httpError";
import type { ClientPortalIdentity } from "../types/client-portal.types";

const PORTAL_AUDIENCE = "cerp-client-portal";
const PORTAL_ISSUER = "cerp-api";
const PORTAL_SESSION_PURPOSE = "client-portal-session-v1";
const PORTAL_INVITATION_PURPOSE = "client-portal-invitation-v1";
const PORTAL_RESET_PURPOSE = "client-portal-password-reset-v1";

type PortalActionTokenPurpose =
  | typeof PORTAL_INVITATION_PURPOSE
  | typeof PORTAL_RESET_PURPOSE;

export type PortalActionTokenData = Readonly<{
  tokenId: string;
  accountId: string;
  createdAt: string;
  expiresAt: string;
}>;

function portalSecret(): string {
  const secret = (process.env.CLIENT_PORTAL_JWT_SECRET ?? "").trim();
  if (secret.length < 32) {
    throw new HttpError(
      503,
      "CLIENT_PORTAL_NOT_CONFIGURED",
      "Le portail client n'est pas configuré sur cet environnement."
    );
  }
  return secret;
}

function isUuid(value: unknown): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function normalizePortalEmail(value: string): string {
  return value.trim().toLocaleLowerCase("fr-FR");
}

export function hashPortalOpaqueValue(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

export function hashPortalRateLimitValue(value: string): string {
  return crypto.createHmac("sha256", portalSecret()).update(value, "utf8").digest("hex");
}

export function stablePortalRequestHash(value: unknown): string {
  return hashPortalOpaqueValue(JSON.stringify(value));
}

export function signPortalSession(identity: ClientPortalIdentity): string {
  return jwt.sign(
    {
      purpose: PORTAL_SESSION_PURPOSE,
      account_id: identity.accountId,
      client_id: identity.clientId,
      session_epoch: identity.sessionEpoch,
    },
    portalSecret(),
    {
      algorithm: "HS256",
      audience: PORTAL_AUDIENCE,
      issuer: PORTAL_ISSUER,
      expiresIn: "15m",
      subject: identity.accountId,
    }
  );
}

export function verifyPortalSession(token: string): ClientPortalIdentity {
  try {
    const decoded = jwt.verify(token, portalSecret(), {
      algorithms: ["HS256"],
      audience: PORTAL_AUDIENCE,
      issuer: PORTAL_ISSUER,
    });
    if (
      typeof decoded !== "object"
      || decoded === null
      || decoded.purpose !== PORTAL_SESSION_PURPOSE
      || !isUuid(decoded.account_id)
      || typeof decoded.client_id !== "string"
      || !/^.{1,3}$/.test(decoded.client_id)
      || typeof decoded.session_epoch !== "number"
      || !Number.isSafeInteger(decoded.session_epoch)
      || decoded.session_epoch < 0
    ) {
      throw new Error("invalid portal claims");
    }
    return {
      accountId: decoded.account_id,
      clientId: decoded.client_id,
      sessionEpoch: decoded.session_epoch,
    };
  } catch {
    throw new HttpError(401, "CLIENT_PORTAL_SESSION_INVALID", "Session portail invalide ou expirée.");
  }
}

function signPortalActionToken(purpose: PortalActionTokenPurpose, data: PortalActionTokenData): string {
  const expiresAtSeconds = Math.floor(new Date(data.expiresAt).getTime() / 1000);
  if (!Number.isSafeInteger(expiresAtSeconds)) throw new Error("Invalid portal token expiry");
  return jwt.sign(
    {
      purpose,
      token_id: data.tokenId,
      account_id: data.accountId,
      created_at: new Date(data.createdAt).toISOString(),
      exp: expiresAtSeconds,
    },
    portalSecret(),
    {
      algorithm: "HS256",
      audience: PORTAL_AUDIENCE,
      issuer: PORTAL_ISSUER,
      noTimestamp: true,
      subject: data.accountId,
    }
  );
}

function verifyPortalActionToken(
  purpose: PortalActionTokenPurpose,
  rawToken: string,
  expiredCode: string,
  invalidCode: string
): Pick<PortalActionTokenData, "tokenId" | "accountId"> {
  try {
    const decoded = jwt.verify(rawToken, portalSecret(), {
      algorithms: ["HS256"],
      audience: PORTAL_AUDIENCE,
      issuer: PORTAL_ISSUER,
    });
    if (
      typeof decoded !== "object"
      || decoded === null
      || decoded.purpose !== purpose
      || !isUuid(decoded.token_id)
      || !isUuid(decoded.account_id)
    ) {
      throw new HttpError(400, invalidCode, "Lien portail invalide ou expiré.");
    }
    return { tokenId: decoded.token_id, accountId: decoded.account_id };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error instanceof jwt.TokenExpiredError) {
      throw new HttpError(400, expiredCode, "Lien portail expiré. Demandez un nouveau lien.");
    }
    throw new HttpError(400, invalidCode, "Lien portail invalide ou expiré.");
  }
}

export function signPortalInvitationToken(data: PortalActionTokenData): string {
  return signPortalActionToken(PORTAL_INVITATION_PURPOSE, data);
}

export function verifyPortalInvitationToken(rawToken: string) {
  return verifyPortalActionToken(
    PORTAL_INVITATION_PURPOSE,
    rawToken,
    "CLIENT_PORTAL_INVITATION_EXPIRED",
    "CLIENT_PORTAL_INVITATION_INVALID"
  );
}

export function signPortalResetToken(data: PortalActionTokenData): string {
  return signPortalActionToken(PORTAL_RESET_PURPOSE, data);
}

export function verifyPortalResetToken(rawToken: string) {
  return verifyPortalActionToken(
    PORTAL_RESET_PURPOSE,
    rawToken,
    "CLIENT_PORTAL_RESET_EXPIRED",
    "CLIENT_PORTAL_RESET_INVALID"
  );
}

