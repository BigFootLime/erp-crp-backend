export const TEST_EMAIL_RECIPIENTS = Object.freeze([
  "clement@croix-rousse-precision.fr",
  "kesmartin2004@croix-rousse-precision.fr",
] as const);

function databaseNameFromUrl(value: string | undefined): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  try {
    const pathname = new URL(raw).pathname;
    const databaseName = decodeURIComponent(pathname.split("/").filter(Boolean).at(-1) ?? "").trim();
    return databaseName || null;
  } catch {
    return null;
  }
}

/**
 * The deployed API deliberately runs with NODE_ENV=development in some environments,
 * so the email safety boundary must use the explicit CERP environment or database name.
 */
export function isTestEmailEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  const explicitMode = (env.CERP_EMAIL_TEST_MODE ?? "").trim().toLowerCase();
  if (["1", "true", "test"].includes(explicitMode)) return true;

  const cerpEnvironment = (env.CERP_ENVIRONMENT ?? "").trim().toLowerCase();
  if (/^(test|testing|sandbox|staging|recette|development|dev)$/.test(cerpEnvironment)) return true;
  if ((env.NODE_ENV ?? "").trim().toLowerCase() === "test") return true;

  const databaseName = databaseNameFromUrl(env.DATABASE_URL)?.toLowerCase() ?? "";
  return /(^|[_-])(test|testing|sandbox|staging|recette|dev|local)($|[_-])/.test(databaseName);
}

export function resolveOutboundEmailRecipients(
  intendedRecipients: readonly string[],
  env: NodeJS.ProcessEnv = process.env
): { recipients: string[]; rerouted: boolean } {
  if (
    env.CERP_E2E_ISOLATED === "1" &&
    env.CERP_E2E_MANAGED_STACK === "1" &&
    env.CERP_E2E_EMAIL_SINK === "1"
  ) {
    const recipients = [...new Set(intendedRecipients.map((recipient) => recipient.trim()).filter(Boolean))];
    if (recipients.length === 0 || recipients.some((recipient) => !recipient.endsWith("@example.local"))) {
      throw new Error("[SOL-05 isolation] email sink recipients must use example.local");
    }
    return { recipients, rerouted: false };
  }
  if (isTestEmailEnvironment(env)) {
    return { recipients: [...TEST_EMAIL_RECIPIENTS], rerouted: true };
  }
  return {
    recipients: [...new Set(intendedRecipients.map((recipient) => recipient.trim()).filter(Boolean))],
    rerouted: false,
  };
}

export function testSafeEmailSubject(subject: string, rerouted: boolean): string {
  return rerouted ? `[TEST - destinataires rediriges] ${subject}` : subject;
}
