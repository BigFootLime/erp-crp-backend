import crypto from "node:crypto";

import { getObservabilityContext } from "./context";
import { runtimeMetadata } from "./runtime";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;
type LogSink = (line: string, level: LogLevel) => void;

const MAX_DEPTH = 5;
const MAX_ARRAY_ITEMS = 20;
const MAX_STRING_LENGTH = 1_024;
const SAFE_IDENTIFIER = /^[a-zA-Z0-9._:-]{1,128}$/;

const nativeWrite: LogSink = (line, level) => {
  const stream = level === "error" || level === "warn" ? process.stderr : process.stdout;
  stream.write(`${line}\n`);
};

let sink: LogSink = nativeWrite;
let consoleInstalled = false;

function scrubString(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted_jwt]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted_email]")
    .replace(/([?&][^=\s&]+)=([^&\s]*)/g, "$1=[redacted]")
    .replace(/\b[A-Za-z]:\\[^\s"']+/g, "[redacted_path]")
    .slice(0, MAX_STRING_LENGTH);
}

function isSensitiveKey(key: string): boolean {
  const compact = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  if ([
    "authorization", "cookie", "email", "phone", "address", "recipient", "content", "body", "payload",
    "filename", "filepath", "storagekey", "storagepath", "absolutepath", "stack", "message", "userid",
    "actorid", "accountid", "customerid", "ip", "clientip", "useragent", "username", "usernameattempt",
    "sql", "query", "statement", "details", "document", "documentname",
  ].includes(compact)) return true;
  return compact.includes("password")
    || compact.includes("passphrase")
    || compact.includes("secret")
    || compact.includes("content")
    || compact.includes("payload")
    || compact.includes("filename")
    || compact.endsWith("token");
}

export function sanitizeLogValue(value: unknown, depth = 0): unknown {
  if (depth >= MAX_DEPTH) return "[truncated]";
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length <= 16_384 && ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]")))) {
      try {
        return sanitizeLogValue(JSON.parse(trimmed), depth + 1);
      } catch {
        // Not valid JSON; continue with bounded string scrubbing.
      }
    }
    return scrubString(value);
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined") return null;
  if (value instanceof Error) {
    return {
      error_type: value.name || "Error",
      error_code: safeErrorCode(value),
      error_fingerprint: errorFingerprint(value),
    };
  }
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitizeLogValue(item, depth + 1));
  }
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>).slice(0, 50)) {
      output[key] = isSensitiveKey(key) ? "[redacted]" : sanitizeLogValue(entry, depth + 1);
    }
    return output;
  }
  return scrubString(String(value));
}

export function safeErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  const code = String((error as { code?: unknown }).code ?? "").trim();
  return SAFE_IDENTIFIER.test(code) ? code : null;
}

export function safeErrorConstraint(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("constraint" in error)) return null;
  const constraint = String((error as { constraint?: unknown }).constraint ?? "").trim();
  return SAFE_IDENTIFIER.test(constraint) ? constraint : null;
}

export function errorFingerprint(error: unknown): string {
  const errorObject = error && typeof error === "object" ? error as { name?: unknown; message?: unknown; code?: unknown } : null;
  const input = [errorObject?.name, errorObject?.code, errorObject?.message]
    .map((part) => String(part ?? "unknown"))
    .join("|");
  return crypto.createHash("sha256").update(input).digest("hex").slice(0, 16);
}

function write(level: LogLevel, event: string, fields: LogFields = {}): void {
  const context = getObservabilityContext();
  const safeEvent = SAFE_IDENTIFIER.test(event) ? event : "invalid_event";
  const sanitized = sanitizeLogValue(fields) as LogFields;
  const suppliedRequestId = typeof sanitized.request_id === "string" && SAFE_IDENTIFIER.test(sanitized.request_id)
    ? sanitized.request_id
    : null;
  const suppliedCorrelationId = typeof sanitized.correlation_id === "string" && SAFE_IDENTIFIER.test(sanitized.correlation_id)
    ? sanitized.correlation_id
    : null;
  const payload = {
    ...sanitized,
    timestamp: new Date().toISOString(),
    level,
    service: runtimeMetadata.service,
    version: runtimeMetadata.version,
    environment: runtimeMetadata.environment,
    event: safeEvent,
    request_id: context?.requestId ?? suppliedRequestId,
    correlation_id: context?.correlationId ?? suppliedCorrelationId,
  };
  sink(JSON.stringify(payload), level);
}

export const logger = Object.freeze({
  debug: (event: string, fields?: LogFields) => write("debug", event, fields),
  info: (event: string, fields?: LogFields) => write("info", event, fields),
  warn: (event: string, fields?: LogFields) => write("warn", event, fields),
  error: (event: string, fields?: LogFields) => write("error", event, fields),
});

function legacyFields(args: unknown[]): LogFields {
  const [first, ...rest] = args;
  if (args.length === 1 && typeof first === "string") {
    try {
      const parsed = JSON.parse(first) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return { legacy: parsed };
      }
    } catch {
      // A plain legacy string is sanitized below.
    }
  }
  return { summary: first ?? null, arguments: rest };
}

export function installStructuredConsole(): void {
  if (process.env.NODE_ENV === "test") return;
  if (consoleInstalled) return;
  consoleInstalled = true;
  console.log = (...args: unknown[]) => logger.info("legacy_console", legacyFields(args));
  console.info = (...args: unknown[]) => logger.info("legacy_console", legacyFields(args));
  console.warn = (...args: unknown[]) => logger.warn("legacy_console", legacyFields(args));
  console.error = (...args: unknown[]) => logger.error("legacy_console", legacyFields(args));
}

export function setLogSinkForTests(nextSink: LogSink | null): void {
  sink = nextSink ?? nativeWrite;
}

// Compatibility boundary: legacy console calls are normalized even when their
// module has not yet migrated to the explicit logger API.
installStructuredConsole();
