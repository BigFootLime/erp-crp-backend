import path from "node:path";

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

function assertLoopbackUrl(name: string, raw: string | undefined, expectedPath?: string): void {
  if (!raw) throw new Error(`[SOL-05 isolation] ${name} is required`);
  const parsed = new URL(raw);
  if (!isLoopback(parsed.hostname)) {
    throw new Error(`[SOL-05 isolation] ${name} must use a loopback host, received ${parsed.hostname}`);
  }
  if (expectedPath !== undefined && parsed.pathname !== expectedPath) {
    throw new Error(`[SOL-05 isolation] ${name} must target ${expectedPath}, received ${parsed.pathname}`);
  }
}

export function assertE2EIsolation(env: NodeJS.ProcessEnv = process.env): void {
  if (env.CERP_E2E_ISOLATED !== "1") return;
  if (env.NODE_ENV !== "test") {
    throw new Error(`[SOL-05 isolation] NODE_ENV=test is required, received ${env.NODE_ENV ?? "unset"}`);
  }

  assertLoopbackUrl("DATABASE_URL", env.DATABASE_URL, "/cerp_test");
  assertLoopbackUrl("FRONTEND_URL", env.FRONTEND_URL);
  assertLoopbackUrl("BACKEND_URL", env.BACKEND_URL);

  for (const origin of (env.CORS_ORIGINS ?? "").split(",").map((value) => value.trim()).filter(Boolean)) {
    assertLoopbackUrl("CORS_ORIGINS", origin);
  }
  if (env.RESEND_API_KEY || env.RESEND_FROM || env.RESEND_API_BASE_URL) {
    if (env.CERP_E2E_EMAIL_SINK !== "1" || !env.RESEND_API_KEY || !env.RESEND_FROM) {
      throw new Error("[SOL-05 isolation] outbound email credentials are forbidden");
    }
    assertLoopbackUrl("RESEND_API_BASE_URL", env.RESEND_API_BASE_URL);
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
