import type { RequestHandler } from "express";
import crypto from "node:crypto";
import { runWithObservabilityContext } from "../shared/observability/context";

const SAFE_TRACE_ID = /^[a-zA-Z0-9._:-]{1,64}$/;

function incomingTraceId(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return SAFE_TRACE_ID.test(trimmed) ? trimmed : null;
}

declare global {
  namespace Express {
    interface Request {
      requestId?: string;
      correlationId?: string;
      rawBody?: Buffer;
    }
  }
}

export const requestIdMiddleware: RequestHandler = (req, res, next) => {
  const requestId = incomingTraceId(req.header("x-request-id")) ?? crypto.randomUUID();
  const correlationId = incomingTraceId(req.header("x-correlation-id")) ?? requestId;

  req.requestId = requestId;
  req.correlationId = correlationId;
  res.setHeader("X-Request-Id", requestId);
  res.setHeader("X-Correlation-Id", correlationId);
  runWithObservabilityContext({ requestId, correlationId }, next);
};
