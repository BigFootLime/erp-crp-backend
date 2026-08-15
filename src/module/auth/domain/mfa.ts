import crypto from "node:crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const TOTP_PERIOD_SECONDS = 30;
const TOTP_DIGITS = 6;
const NON_PRODUCTION_ROOT_KEY = Buffer.from(
  "9ddf1be3a6d4ae10ce5f4d410dd82f30a0e15b5de8388e251ad95ce87eb5206b",
  "hex",
);

export type EncryptedMfaSecret = {
  encrypted: Buffer;
  iv: Buffer;
  tag: Buffer;
  keyId: string;
};

let warnedAboutFallback = false;

function rootKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = env.MFA_ROOT_KEY?.trim();
  if (raw) {
    const decoded = /^[0-9a-f]{64}$/i.test(raw)
      ? Buffer.from(raw, "hex")
      : Buffer.from(raw, "base64");
    if (decoded.length !== 32) {
      throw new Error("MFA_ROOT_KEY must encode exactly 32 bytes");
    }
    return decoded;
  }
  if (env.NODE_ENV === "production") {
    throw new Error("MFA_ROOT_KEY is required in production");
  }
  if (!warnedAboutFallback && env.NODE_ENV !== "test") {
    warnedAboutFallback = true;
    console.warn(JSON.stringify({
      type: "mfa_non_production_key",
      message: "MFA_ROOT_KEY is absent; the disposable non-production key is active",
    }));
  }
  return NON_PRODUCTION_ROOT_KEY;
}

function deriveKey(purpose: "encryption" | "recovery", env: NodeJS.ProcessEnv = process.env): Buffer {
  return Buffer.from(crypto.hkdfSync(
    "sha256",
    rootKey(env),
    Buffer.from("cerp-sol32-mfa-v1", "utf8"),
    Buffer.from(purpose, "utf8"),
    32,
  ));
}

export function currentMfaKeyId(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.MFA_KEY_ID?.trim();
  if (configured) {
    if (!/^[A-Za-z0-9._-]{1,80}$/.test(configured)) throw new Error("MFA_KEY_ID is invalid");
    return configured;
  }
  return env.NODE_ENV === "production" ? "production-v1" : "non-production-v1";
}

export function assertMfaStartupConfiguration(env: NodeJS.ProcessEnv = process.env): void {
  rootKey(env);
  currentMfaKeyId(env);
}

export function encryptMfaSecret(secret: string, env: NodeJS.ProcessEnv = process.env): EncryptedMfaSecret {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", deriveKey("encryption", env), iv);
  cipher.setAAD(Buffer.from("cerp:user-mfa-factor:v1", "utf8"));
  const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return { encrypted, iv, tag: cipher.getAuthTag(), keyId: currentMfaKeyId(env) };
}

export function decryptMfaSecret(value: EncryptedMfaSecret, env: NodeJS.ProcessEnv = process.env): string {
  if (value.keyId !== currentMfaKeyId(env)) {
    throw new Error(`Unsupported MFA key id: ${value.keyId}`);
  }
  const decipher = crypto.createDecipheriv("aes-256-gcm", deriveKey("encryption", env), value.iv);
  decipher.setAAD(Buffer.from("cerp:user-mfa-factor:v1", "utf8"));
  decipher.setAuthTag(value.tag);
  return Buffer.concat([decipher.update(value.encrypted), decipher.final()]).toString("utf8");
}

export function encodeBase32(input: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of input) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function decodeBase32(input: string): Buffer {
  const normalized = input.toUpperCase().replace(/=+$/u, "").replace(/\s+/gu, "");
  let bits = 0;
  let value = 0;
  const output: number[] = [];
  for (const character of normalized) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index < 0) throw new Error("Invalid base32 secret");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

export function generateTotpSecret(): string {
  return encodeBase32(crypto.randomBytes(20));
}

export function totpForStep(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = crypto.createHmac("sha1", decodeBase32(secret)).update(counter).digest();
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  const binary = ((digest[offset] ?? 0) & 0x7f) << 24
    | ((digest[offset + 1] ?? 0) & 0xff) << 16
    | ((digest[offset + 2] ?? 0) & 0xff) << 8
    | ((digest[offset + 3] ?? 0) & 0xff);
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

export function verifyTotp(params: {
  secret: string;
  code: string;
  nowMs?: number;
  driftSteps?: number;
}): number | null {
  const code = params.code.replace(/\s+/gu, "");
  if (!/^\d{6}$/.test(code)) return null;
  const currentStep = Math.floor((params.nowMs ?? Date.now()) / 1000 / TOTP_PERIOD_SECONDS);
  const drift = params.driftSteps ?? 1;
  for (let delta = -drift; delta <= drift; delta += 1) {
    const step = currentStep + delta;
    const expected = totpForStep(params.secret, step);
    if (crypto.timingSafeEqual(Buffer.from(code), Buffer.from(expected))) return step;
  }
  return null;
}

export function buildOtpAuthUri(params: { username: string; issuer?: string; secret: string }): string {
  const issuer = params.issuer?.trim() || "CERP+";
  const label = `${issuer}:${params.username}`;
  return `otpauth://totp/${encodeURIComponent(label)}?secret=${params.secret}`
    + `&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_PERIOD_SECONDS}`;
}

export function opaqueChallengeToken(): { token: string; hash: string } {
  const token = crypto.randomBytes(32).toString("base64url");
  return { token, hash: crypto.createHash("sha256").update(token).digest("hex") };
}

export function hashChallengeToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function normalizeRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/gu, "");
}

export function hashRecoveryCode(code: string, env: NodeJS.ProcessEnv = process.env): string {
  return crypto.createHmac("sha256", deriveKey("recovery", env))
    .update(normalizeRecoveryCode(code))
    .digest("hex");
}

export function generateRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () => {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const raw = Array.from({ length: 16 }, () => alphabet[crypto.randomInt(0, alphabet.length)]).join("");
    return raw.match(/.{1,4}/gu)?.join("-") ?? raw;
  });
}
