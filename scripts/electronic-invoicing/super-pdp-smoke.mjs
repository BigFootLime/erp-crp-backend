import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const compiledClient = path.join(
  root,
  "dist/module/facturation/electronic-invoicing/providers/super-pdp/super-pdp.client.js"
);
const require = createRequire(import.meta.url);

let clientModule;
try {
  clientModule = require(compiledClient);
} catch {
  console.error("SUPER_PDP_SMOKE_BUILD_REQUIRED: exécutez d'abord pnpm build.");
  process.exitCode = 2;
}

if (clientModule) {
  const configuration = clientModule.loadSuperPdpConfiguration(process.env);
  if (configuration.environment !== "sandbox" && process.env.SUPER_PDP_ALLOW_PRODUCTION_SMOKE !== "true") {
    console.error("SUPER_PDP_SMOKE_PRODUCTION_BLOCKED: utilisez le bac à sable ou autorisez explicitement le diagnostic production.");
    process.exitCode = 2;
  } else {
    const diagnostic = await new clientModule.SuperPdpClient(configuration).diagnose();
    console.log(JSON.stringify({
      provider: diagnostic.provider,
      environment: diagnostic.environment,
      configured: diagnostic.configured,
      reachable: diagnostic.reachable,
      authenticated: diagnostic.authenticated,
      company_verification_status: diagnostic.company_verification_status,
      api_contract_version: diagnostic.api_contract_version,
      checked_at: diagnostic.checked_at,
      latency_ms: diagnostic.latency_ms,
      failure_code: diagnostic.failure_code,
      message: diagnostic.message,
    }, null, 2));
    if (!diagnostic.authenticated || diagnostic.failure_code) process.exitCode = 1;
  }
}
