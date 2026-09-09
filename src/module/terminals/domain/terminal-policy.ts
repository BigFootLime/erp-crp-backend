import { createHash, createHmac, randomBytes } from "node:crypto";
import { HttpError } from "../../../utils/httpError";

export const TERMINAL_KINDS = [
  "OPERATOR",
  "TOOLING",
  "MATERIAL",
  "ARTICLES",
  "RECEPTION",
  "OF_PROCUREMENT",
] as const;
export type TerminalKind = (typeof TERMINAL_KINDS)[number];
export const terminalModule: Record<TerminalKind, string> = {
  OPERATOR: "production",
  TOOLING: "outillage",
  MATERIAL: "stock",
  ARTICLES: "stock",
  RECEPTION: "qualite",
  OF_PROCUREMENT: "production",
};
export const tokenHash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const newDeviceToken = () => randomBytes(32).toString("base64url");
export const newPairingCode = () =>
  randomBytes(16).toString("hex").toUpperCase();
export function pinFingerprint(
  site: string,
  pin: string,
  pepper = process.env.TERMINAL_PIN_PEPPER ?? "",
) {
  if (!/^\d{4}$/.test(pin))
    throw new HttpError(
      400,
      "TERMINAL_PIN_FORMAT",
      "Saisissez les quatre chiffres de votre code.",
    );
  if (pepper.length < 32)
    throw new HttpError(
      503,
      "TERMINAL_PIN_UNAVAILABLE",
      "La connexion par code personnel n’est pas configurée.",
    );
  return createHmac("sha256", pepper)
    .update(JSON.stringify(["cerp-terminal-pin-v1", site, pin]))
    .digest("hex");
}
export function assertSameTerminal(
  expected: string,
  actual: string | undefined,
) {
  if (expected !== actual)
    throw new HttpError(
      403,
      "TERMINAL_SESSION_DEVICE",
      "Cette session appartient à un autre terminal.",
    );
}
export function assertProgramConfirmation(
  expected: string | null,
  supplied: string,
) {
  if (!expected || expected !== supplied)
    throw new HttpError(
      409,
      "TERMINAL_PROGRAM_CHANGED",
      "Le programme applicable a changé. Consultez sa version avant de confirmer.",
    );
}
export function requireAlternativeReason(
  recommended: string | null,
  selected: string,
  reason?: string,
) {
  if (
    recommended &&
    recommended !== selected &&
    (!reason || reason.trim().length < 3)
  ) {
    throw new HttpError(
      422,
      "TERMINAL_SEQUENCE_REASON",
      "Indiquez pourquoi vous choisissez cette opération.",
    );
  }
}
