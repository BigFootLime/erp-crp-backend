import crypto from "node:crypto";
import type { Request, RequestHandler } from "express";

import { logger } from "../shared/observability/logger";
import { observeHttpRequest } from "../shared/observability/metrics";
import { stripQueryFromUrl } from "../utils/logPath";

const BUSINESS_ENTITY_SEGMENTS = new Set([
  "articles", "commandes", "factures", "livraisons", "machines", "ofs", "ordres-fabrication",
]);

export function observabilityRoute(req: Pick<Request, "originalUrl" | "baseUrl" | "route">): string {
  const routePath = typeof req.route?.path === "string" ? req.route.path : null;
  if (routePath) {
    const normalized = `${req.baseUrl ?? ""}${routePath}`.replace(/\/{2,}/g, "/");
    return normalized.length > 1 ? normalized.replace(/\/$/, "") : normalized;
  }
  const path = stripQueryFromUrl(req.originalUrl) ?? "/unknown";
  return path
    .split("/")
    .map((segment) => (/^\d+$/.test(segment) || /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(segment) ? ":id" : segment))
    .slice(0, 7)
    .join("/");
}

function businessEntity(originalUrl: string): { entity_type?: string; entity_ref?: string } {
  const segments = (stripQueryFromUrl(originalUrl) ?? "").split("/").filter(Boolean);
  for (let index = 0; index < segments.length - 1; index += 1) {
    if (!BUSINESS_ENTITY_SEGMENTS.has(segments[index])) continue;
    const identifier = segments[index + 1];
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(identifier)) return {};
    return {
      entity_type: segments[index],
      entity_ref: crypto.createHash("sha256").update(identifier).digest("hex").slice(0, 12),
    };
  }
  return {};
}

export const requestLogger: RequestHandler = (req, res, next) => {
  const startedAt = Date.now();

  res.on("finish", () => {
    const durationMs = Date.now() - startedAt;
    const route = observabilityRoute(req);
    const fields = {
      http_method: req.method,
      http_route: route,
      http_status: res.statusCode,
      duration_ms: durationMs,
      ...businessEntity(req.originalUrl),
    };
    observeHttpRequest(req.method, route, res.statusCode, durationMs);
    if (res.statusCode >= 500) logger.error("http_request_completed", fields);
    else if (res.statusCode >= 400) logger.warn("http_request_completed", fields);
    else logger.info("http_request_completed", fields);
  });

  next();
};
