import { e2eListenHost } from "../../config/e2e-isolation";

import type { BackgroundWorkerMode } from "./background-lifecycle";

/**
 * Leader mode keeps the normal API/Socket process for the deployment
 * architecture, but it is never a routed endpoint and is loopback-only.
 */
export function runtimeListenHost(mode: BackgroundWorkerMode, env: NodeJS.ProcessEnv = process.env): string {
  if (mode === "leader") return "127.0.0.1";
  return env.CERP_MANAGED_TEST_ID ? "127.0.0.1" : e2eListenHost(env);
}
