const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function isCustomerDeployment(env: NodeJS.ProcessEnv = process.env): boolean {
  const profile = env.CERP_DEPLOYMENT_PROFILE ?? "internal";
  if (!["internal", "customer"].includes(profile)) throw new Error("CERP_DEPLOYMENT_PROFILE must be internal or customer");
  return profile === "customer";
}
export function deploymentIdentity(env: NodeJS.ProcessEnv = process.env): { installationId: string; enterpriseId: string } | null {
  if (!isCustomerDeployment(env)) return null;
  const installationId = env.CERP_INSTALLATION_ID ?? "";
  const enterpriseId = env.CERP_ENTERPRISE_ID ?? "";
  if (!UUID.test(installationId) || !UUID.test(enterpriseId)) {
    throw new Error("Customer deployment requires valid CERP_INSTALLATION_ID and CERP_ENTERPRISE_ID");
  }
  return { installationId, enterpriseId };
}
export function assertDeploymentSecurity(env: NodeJS.ProcessEnv = process.env): void {
  const customer = isCustomerDeployment(env);
  if (env.NODE_ENV !== "test" && (!env.JWT_SECRET || env.JWT_SECRET.length < 32)) throw new Error("JWT_SECRET must contain at least 32 characters outside isolated tests");
  if (!customer) return;
  deploymentIdentity(env);
  if (env.NODE_ENV !== "production") throw new Error("Customer deployment requires NODE_ENV=production");
  if (!env.JWT_SECRET || env.JWT_SECRET.length < 32) throw new Error("JWT_SECRET must contain at least 32 characters");
  if (!env.MFA_ROOT_KEY) throw new Error("MFA_ROOT_KEY is required");
  if (!env.AUTH_RATE_LIMIT_HASH_KEY || env.AUTH_RATE_LIMIT_HASH_KEY.length < 32) throw new Error("AUTH_RATE_LIMIT_HASH_KEY must contain at least 32 characters");
  if (["0", "false", "no", "off"].includes((env.AUTH_RATE_LIMIT_ENABLED ?? "true").toLowerCase())) throw new Error("Customer deployment requires authentication rate limiting");
  if (env.CERP_MODULE_ACCESS_GATE_DISABLED === "1") throw new Error("Customer deployment cannot disable module authorization");
  const origins = (env.CORS_ORIGINS ?? "").split(",").map(value => value.trim()).filter(Boolean);
  if (!origins.length) throw new Error("Customer deployment requires explicit CORS_ORIGINS");
  for (const origin of origins) {
    if (origin === "app://cerp") continue;
    const url = new URL(origin);
    if (url.protocol !== "https:" || url.username || url.password || origin !== url.origin) {
      throw new Error("Customer CORS origins must be HTTPS origins without credentials or paths");
    }
  }
}
