const DEMO_DATABASE = "cerp_demo";

export type DemoCapabilities = {
  read: string[];
  write: string[];
};

export const DEMO_CAPABILITIES: DemoCapabilities = {
  read: [
    "dashboard", "clients", "devis", "affaires", "commandes", "stock", "production", "planning",
    "fournisseurs", "pieces-techniques", "qualite", "metrologie", "livraisons", "notifications",
  ],
  write: ["clients:create", "devis:draft", "stock:preview", "stock:simulate"],
};

export function isDemoMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CERP_DEMO_MODE === "true";
}

function databaseName(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    return new URL(raw).pathname.replace(/^\//, "") || null;
  } catch {
    return null;
  }
}

/**
 * A demo process must be physically isolated at the database connection.
 * Never make cerp_demo a selectable database in a shared production process.
 */
export function assertDemoDatabaseIsolation(env: NodeJS.ProcessEnv = process.env): void {
  const database = databaseName(env.DATABASE_URL);
  if (isDemoMode(env) && database !== DEMO_DATABASE) {
    throw new Error("[demo] CERP_DEMO_MODE=true requires DATABASE_URL for cerp_demo");
  }
  if (!isDemoMode(env) && database === DEMO_DATABASE) {
    throw new Error("[demo] DATABASE_URL for cerp_demo requires CERP_DEMO_MODE=true");
  }
}

export function isDemoDatabaseId(value: unknown): value is "cerp_demo" {
  return value === DEMO_DATABASE;
}
