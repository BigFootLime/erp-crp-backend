import crypto from "node:crypto";
import jwt from "jsonwebtoken";

import { HttpError } from "../../../utils/httpError";

const ACCOUNT_INVITATION_PURPOSE = "cerp-account-activation-v1";

export type AccountInvitationTokenData = {
  invitationId: string;
  userId: number;
  createdAt: string;
  expiresAt: string;
};

function invitationSecret(): string {
  const secret = (process.env.JWT_SECRET ?? "").trim();
  if (!secret) throw new Error("JWT_SECRET is required for account invitations");
  return secret;
}

export function signAccountInvitationToken(data: AccountInvitationTokenData): string {
  const expiresAtSeconds = Math.floor(new Date(data.expiresAt).getTime() / 1000);
  if (!Number.isSafeInteger(expiresAtSeconds)) {
    throw new Error("Invalid account invitation expiry");
  }
  return jwt.sign(
    {
      purpose: ACCOUNT_INVITATION_PURPOSE,
      invitation_id: data.invitationId,
      user_id: data.userId,
      issued_at: new Date(data.createdAt).toISOString(),
      exp: expiresAtSeconds,
    },
    invitationSecret(),
    { algorithm: "HS256", noTimestamp: true },
  );
}

export function hashAccountInvitationToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function verifyAccountInvitationToken(token: string): {
  invitationId: string;
  userId: number;
} {
  try {
    const decoded = jwt.verify(token, invitationSecret(), { algorithms: ["HS256"] });
    if (
      typeof decoded !== "object"
      || decoded === null
      || decoded.purpose !== ACCOUNT_INVITATION_PURPOSE
      || typeof decoded.invitation_id !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(decoded.invitation_id)
      || typeof decoded.user_id !== "number"
      || !Number.isSafeInteger(decoded.user_id)
      || decoded.user_id < 1
    ) {
      throw new HttpError(400, "INVITATION_INVALID", "Invitation invalide ou expirée.");
    }
    return { invitationId: decoded.invitation_id, userId: decoded.user_id };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    if (err instanceof jwt.TokenExpiredError) {
      throw new HttpError(400, "INVITATION_EXPIRED", "Invitation expirée. Demandez un nouveau lien.");
    }
    throw new HttpError(400, "INVITATION_INVALID", "Invitation invalide ou expirée.");
  }
}
