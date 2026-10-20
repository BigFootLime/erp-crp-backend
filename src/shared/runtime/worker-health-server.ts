import { createServer, type Server } from "node:http";

import { getBackgroundRuntimeReadiness, type BackgroundRuntimeReadiness } from "./background-runtime";

function workerHealthPort(environment: NodeJS.ProcessEnv): number {
  const parsed = Number.parseInt(environment.CERP_WORKER_HEALTH_PORT ?? "5001", 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw Object.assign(new Error("CERP_WORKER_HEALTH_PORT_INVALID"), { code: "CERP_WORKER_HEALTH_PORT_INVALID" });
  }
  return parsed;
}

export type WorkerHealthResponse = Readonly<{ statusCode: number; body: string }>;

export function workerHealthResponse(method: string | undefined, url: string | undefined): WorkerHealthResponse {
  if (method !== "GET" || !["/health/live", "/health/ready"].includes(url ?? "")) {
    return { statusCode: 404, body: JSON.stringify({ error: "NOT_FOUND" }) };
  }
  const readiness: BackgroundRuntimeReadiness = getBackgroundRuntimeReadiness();
  return {
    statusCode: url === "/health/ready" && !readiness.ready ? 503 : 200,
    body: JSON.stringify({ status: readiness.ready ? "ready" : "not_ready", background_runtime: readiness }),
  };
}

export type WorkerHealthServer = Readonly<{
  server: Server;
  port: number;
  close: () => Promise<void>;
}>;

/** A loopback-only health surface for worker processes; it mounts no ERP routes. */
export async function startWorkerHealthServer(environment = process.env): Promise<WorkerHealthServer> {
  const port = workerHealthPort(environment);
  const server = createServer((request, response) => {
    const health = workerHealthResponse(request.method, request.url);
    response.writeHead(health.statusCode, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(health.body);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    server,
    port,
    close: async () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}
