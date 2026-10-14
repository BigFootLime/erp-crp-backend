import bcrypt from "bcryptjs";
import { createHmac } from "node:crypto";
import { HttpError } from "../../../utils/httpError";
import { registerTestAccount,registrationEnabled } from "../repository/test-registration.repository";
import { loginUser } from "./auth.service";
import type { MfaAuditMeta } from "./mfa.service";
import type { TestRegistration } from "../validators/test-registration.validator";

export async function createTestAccount(input: TestRegistration, key: string, meta: MfaAuditMeta) {
  if(!await registrationEnabled()) throw new HttpError(403,"TEST_REGISTRATION_DISABLED","La création de compte est fermée sur cet environnement.");
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new HttpError(503,"AUTH_UNAVAILABLE","Service d’authentification indisponible.");
  // Keyed digest permits exact replay without retaining the password or an offline password verifier.
  const requestHash=createHmac("sha256",secret).update(JSON.stringify({...input,working_days:[...input.working_days].sort()})).digest("hex");
  let account;
  try { account=await registerTestAccount(input,await bcrypt.hash(input.password,12),key,requestHash,meta); }
  catch(error) {
    if (typeof error === "object" && error && "code" in error && error.code === "23505") throw new HttpError(409,"ACCOUNT_CONFLICT","Un compte utilise déjà cet identifiant ou cette adresse. Connectez-vous ou modifiez la saisie.");
    throw error;
  }
  // Normal password checks, MFA challenge expiry/rate limits and recovery codes remain authoritative.
  const response=await loginUser(input.username,input.password,meta);
  return { ...response, replayed:account.replayed };
}
