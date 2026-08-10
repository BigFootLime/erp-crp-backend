import crypto from "node:crypto";
import { Router, type RequestHandler } from "express";
import type { Pool } from "pg";

import { collectReadiness } from "./health";
import { logger } from "./logger";
import { prometheusContentType, renderPrometheusMetrics } from "./metrics";
import { runtimeMetadata } from "./runtime";

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

export function requireMetricsToken(environment = process.env): RequestHandler {
  return (req, res, next) => {
    const expected = environment.CERP_OBSERVABILITY_TOKEN?.trim() ?? "";
    if (!expected) {
      logger.error("metrics_configuration_missing");
      res.status(503).json({ code: "METRICS_NOT_CONFIGURED", message: "Supervision non configurée." });
      return;
    }
    const authorization = req.header("authorization")?.trim() ?? "";
    const bearer = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
    const provided = req.header("x-observability-token")?.trim() || bearer;
    if (!provided || !safeEqual(provided, expected)) {
      logger.warn("metrics_access_denied", { method: req.method, http_route: "/internal/metrics" });
      res.status(401).json({ code: "METRICS_UNAUTHORIZED", message: "Accès refusé." });
      return;
    }
    next();
  };
}

export function createObservabilityRouter(pool: Pool): Router {
  const router = Router();

  router.get("/health/live", (_req, res) => {
    res.json({
      status: "alive",
      ...runtimeMetadata,
      observed_at: new Date().toISOString(),
      uptime_seconds: Math.floor(process.uptime()),
    });
  });

  router.get("/health/ready", async (_req, res) => {
    const report = await collectReadiness(pool);
    res.status(report.status === "ready" ? 200 : 503).json(report);
  });

  router.get("/internal/metrics", requireMetricsToken(), async (_req, res) => {
    await collectReadiness(pool);
    res.type(prometheusContentType).send(renderPrometheusMetrics(pool));
  });

  return router;
}

