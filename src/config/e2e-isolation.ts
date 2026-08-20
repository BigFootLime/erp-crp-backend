import path from "node:path";

function assertAllowedUrl(
  name: string,
  raw: string | undefined,
  allowedHosts: ReadonlySet<string>,
  expectedPath?: string
): void {
  if (!raw) throw new Error(`[SOL-05 isolation] ${name} is required`);
  const parsed = new URL(raw);
  if (!allowedHosts.has(parsed.hostname)) {
    throw new Error(`[SOL-05 isolation] ${name} host is forbidden, received ${parsed.hostname}`);
  }
  if (expectedPath !== undefined && parsed.pathname !== expectedPath) {
    throw new Error(`[SOL-05 isolation] ${name} must target ${expectedPath}, received ${parsed.pathname}`);
  }
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function isManagedE2EContainer(env: NodeJS.ProcessEnv): boolean {
  return env.CERP_E2E_MANAGED_STACK === "1" && env.CERP_E2E_CONTAINER === "1";
}

export function e2eListenHost(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CERP_E2E_ISOLATED !== "1") return "0.0.0.0";
  return isManagedE2EContainer(env) ? "0.0.0.0" : "127.0.0.1";
}

export function assertE2EIsolation(env: NodeJS.ProcessEnv = process.env): void {
  if (env.CERP_E2E_ISOLATED !== "1") return;
  if (env.NODE_ENV !== "test") {
    throw new Error(`[SOL-05 isolation] NODE_ENV=test is required, received ${env.NODE_ENV ?? "unset"}`);
  }

  if (env.CERP_E2E_CONTAINER === "1" && env.CERP_E2E_MANAGED_STACK !== "1") {
    throw new Error("[SOL-05 isolation] container mode requires CERP_E2E_MANAGED_STACK=1");
  }

  const managedContainer = isManagedE2EContainer(env);
  const databaseHosts = managedContainer ? new Set(["postgres"]) : LOOPBACK_HOSTS;

  assertAllowedUrl("DATABASE_URL", env.DATABASE_URL, databaseHosts, "/cerp_test");
  assertAllowedUrl("FRONTEND_URL", env.FRONTEND_URL, LOOPBACK_HOSTS);
  assertAllowedUrl("BACKEND_URL", env.BACKEND_URL, LOOPBACK_HOSTS);

  for (const origin of (env.CORS_ORIGINS ?? "").split(",").map((value) => value.trim()).filter(Boolean)) {
    assertAllowedUrl("CORS_ORIGINS", origin, LOOPBACK_HOSTS);
  }
  if (env.RESEND_API_KEY || env.RESEND_FROM || env.RESEND_API_BASE_URL) {
    if (env.CERP_E2E_EMAIL_SINK !== "1" || !env.RESEND_API_KEY || !env.RESEND_FROM) {
      throw new Error("[SOL-05 isolation] outbound email credentials are forbidden");
    }
    assertAllowedUrl(
      "RESEND_API_BASE_URL",
      env.RESEND_API_BASE_URL,
      managedContainer ? new Set(["host.docker.internal"]) : LOOPBACK_HOSTS
    );
    if (!env.RESEND_FROM.toLowerCase().includes("@example.local")) {
      throw new Error("[SOL-05 isolation] RESEND_FROM must use example.local");
    }
  }

  const runRoot = env.CERP_E2E_RUN_ROOT ? path.resolve(env.CERP_E2E_RUN_ROOT) : null;
  if (!runRoot) throw new Error("[SOL-05 isolation] CERP_E2E_RUN_ROOT is required");
  for (const name of [
    "CERP_ROOT",
    "CERP_STORAGE_ROOT",
    "CERP_DOCUMENTS_ROOT",
    "CERP_GENERATED_ROOT",
    "CERP_INBOUND_ROOT",
    "CERP_EXPORTS_ROOT",
    "CERP_TMP_ROOT",
    "CERP_IMAGES_ROOT",
    "CERP_GED_VAULT_ROOT",
  ]) {
    const value = env[name];
    if (!value) throw new Error(`[SOL-05 isolation] ${name} is required`);
    const resolved = path.resolve(value);
    const relative = path.relative(runRoot, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`[SOL-05 isolation] ${name} escapes CERP_E2E_RUN_ROOT`);
    }
  }
}
