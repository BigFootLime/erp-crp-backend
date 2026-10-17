import { isCustomerDeployment } from "./deployment-security";
export function createOriginPolicy(env: NodeJS.ProcessEnv = process.env, desktop = false) {
  const customer = isCustomerDeployment(env);
  const origins = new Set<string>((env.CORS_ORIGINS ?? "").split(",").map(value => value.trim()).filter(Boolean));
  if (!customer) {
    for (const origin of ["https://cerp.croix-rousse-precision.fr", "http://cerp.croix-rousse-precision.fr",
      "http://localhost:5173", "http://localhost:5137", "http://localhost:4173",
      "http://127.0.0.1:5173", "http://127.0.0.1:5137", "http://127.0.0.1:4173"]) origins.add(origin);
    if (desktop) origins.add("app://cerp");
  }
  return (origin: string) => origins.has(origin) || (!customer && /^http:\/\/(localhost|127\.0\.0\.1):\d+$/i.test(origin));
}
