import express from "express";
import type { Pool } from "pg";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { requestIdMiddleware } from "../middlewares/requestId";
import { requestLogger } from "../middlewares/requestLogger";
import { getObservabilityContext } from "../shared/observability/context";
import { collectReadiness } from "../shared/observability/health";
import { logger, setLogSinkForTests } from "../shared/observability/logger";
import {
  markJobFinished,
  markJobStarted,
  observeHttpRequest,
  renderPrometheusMetrics,
  resetMetricsForTests,
} from "../shared/observability/metrics";
import { requireMetricsToken } from "../shared/observability/routes";

describe("SOL-09 — corrélation et journaux sûrs", () => {
  const lines: string[] = [];

  beforeEach(() => {
    lines.length = 0;
    setLogSinkForTests((line) => lines.push(line));
    resetMetricsForTests();
  });

  afterEach(() => setLogSinkForTests(null));

  it("propage les identifiants valides et refuse les valeurs injectables", async () => {
    const app = express();
    app.use(requestIdMiddleware);
    app.get("/probe", async (_req, res) => {
      await new Promise((resolve) => setImmediate(resolve));
      res.json(getObservabilityContext());
    });

    const accepted = await request(app)
      .get("/probe")
      .set("X-Request-Id", "req-ui-42")
      .set("X-Correlation-Id", "corr-order-42")
      .expect(200);
    expect(accepted.headers["x-request-id"]).toBe("req-ui-42");
    expect(accepted.headers["x-correlation-id"]).toBe("corr-order-42");
    expect(accepted.body).toEqual({ requestId: "req-ui-42", correlationId: "corr-order-42" });

    const rejected = await request(app)
      .get("/probe")
      .set("X-Request-Id", "bad id with spaces")
      .expect(200);
    expect(rejected.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(rejected.headers["x-request-id"]).not.toBe("bad id with spaces");
  });

  it("retrouve la même référence de l'écran dans le log HTTP backend", async () => {
    const app = express();
    app.use(requestIdMiddleware);
    app.use(requestLogger);
    app.get("/api/v1/commandes/:id", (_req, res) => res.status(503).json({ code: "DEGRADED" }));

    await request(app)
      .get("/api/v1/commandes/4242?customer_email=private@example.com")
      .set("X-Request-Id", "screen-reference-42")
      .set("X-Correlation-Id", "user-operation-42")
      .expect(503);

    const event = lines.map((line) => JSON.parse(line)).find((entry) => entry.event === "http_request_completed");
    expect(event).toMatchObject({
      request_id: "screen-reference-42",
      correlation_id: "user-operation-42",
      http_method: "GET",
      http_route: "/api/v1/commandes/:id",
      http_status: 503,
      entity_type: "commandes",
    });
    expect(JSON.stringify(event)).not.toContain("private@example.com");
    expect(JSON.stringify(event)).not.toContain("4242");
  });

  it("expurge secrets, PII, contenu et chemins sans perdre le diagnostic", () => {
    logger.error("document_upload_failed", {
      authorization: "Bearer top-secret",
      email: "personne@example.com",
      document_content: "contrat client",
      storage_path: "C:\\private\\customer\\document.pdf",
      sql: "SELECT * FROM users WHERE email='personne@example.com'",
      details: { token: "nested-secret" },
      timestamp: "forged",
      level: "info",
      service: "forged-service",
      event: "forged_event",
      reason_code: "GED_VAULT_FULL",
      summary: "query?token=secret personne@example.com C:\\private\\file.pdf",
    });

    const output = lines.join("\n");
    const parsed = JSON.parse(lines[0]);
    expect(output).toContain('"event":"document_upload_failed"');
    expect(output).toContain('"reason_code":"GED_VAULT_FULL"');
    expect(output).toContain("[redacted]");
    expect(parsed).toMatchObject({ level: "error", service: "cerp-api", event: "document_upload_failed" });
    expect(parsed.timestamp).not.toBe("forged");
    expect(output).not.toContain("top-secret");
    expect(output).not.toContain("personne@example.com");
    expect(output).not.toContain("contrat client");
    expect(output).not.toContain("nested-secret");
    expect(output).not.toContain("SELECT");
    expect(output).not.toContain("forged-service");
    expect(output).not.toContain("private");
  });

  it("protège /internal/metrics et compare le jeton sans fuite", async () => {
    const app = express();
    app.get(
      "/internal/metrics",
      requireMetricsToken({ CERP_OBSERVABILITY_TOKEN: "metrics-test-secret" }),
      (_req, res) => res.send("ok")
    );
    await request(app).get("/internal/metrics").expect(401);
    await request(app).get("/internal/metrics").set("X-Observability-Token", "wrong").expect(401);
    await request(app).get("/internal/metrics").set("X-Observability-Token", "metrics-test-secret").expect(200, "ok");
    expect(lines.join("\n")).not.toContain("metrics-test-secret");
  });

  it("expose des métriques à cardinalité bornée pour HTTP, DB et jobs", () => {
    observeHttpRequest("GET", "/api/v1/commandes/:id", 503, 275);
    markJobStarted("advanced_reminders", 1_000);
    markJobFinished("advanced_reminders", false, 2_000);
    const pool = { totalCount: 10, idleCount: 1, waitingCount: 4, options: { max: 10 } } as Pool;
    const metrics = renderPrometheusMetrics(pool);
    expect(metrics).toContain('cerp_http_requests_total{method="GET",route="/api/v1/commandes/:id",status_class="5xx"} 1');
    expect(metrics).toContain('cerp_db_pool_connections{state="waiting"} 4');
    expect(metrics).toContain('cerp_job_failures_total{job="advanced_reminders"} 1');
  });
});

describe("SOL-09 — readiness représentative", () => {
  beforeEach(() => resetMetricsForTests());

  it("bloque la production quand la DB tombe et indique le périmètre touché", async () => {
    const pool = {} as Pool;
    const report = await collectReadiness(
      pool,
      {
        queryDatabase: async () => { throw Object.assign(new Error("private DSN"), { code: "ECONNREFUSED" }); },
        checkGed: async () => ({
          configured: true,
          root_present: true,
          sentinel_required: true,
          sentinel_present: true,
          writable: true,
          healthy: true,
          detail: null,
          capacity_bytes: 1_000,
          available_bytes: 500,
          used_ratio: 0.5,
          inode_total: 100,
          inode_free: 50,
        }),
        scanner: async () => ({ mode: "enforce", provider: "clamdscan", command: "clamdscan", timeoutMs: 1_000, ready: true }),
        realtime: () => ({ ready: true }) as ReturnType<typeof import("../sockets/sockeServer").getRealtimeReadiness>,
      },
      { NODE_ENV: "production" }
    );

    expect(report.status).toBe("not_ready");
    expect(report.checks.database).toMatchObject({
      status: "down",
      required: true,
      reason_code: "ECONNREFUSED",
      affected_scope: "all_transactional_flows",
      source: "postgres_probe",
      freshness_seconds: 0,
      reliability: "MEASURED",
    });
    expect(JSON.stringify(report)).not.toContain("private DSN");
  });
});
