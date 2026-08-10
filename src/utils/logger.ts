import { logger as structuredLogger } from "../shared/observability/logger";

function fields(args: unknown[]): Record<string, unknown> {
  return { summary: args[0] ?? null, arguments: args.slice(1) };
}

const testMode = process.env.NODE_ENV === "test";
const log = (...args: unknown[]) => testMode ? console.log("[LOG]", ...args) : structuredLogger.info("application_event", fields(args));
const info = (...args: unknown[]) => testMode ? console.info("[INFO]", ...args) : structuredLogger.info("application_event", fields(args));
const error = (...args: unknown[]) => testMode ? console.error("[ERROR]", ...args) : structuredLogger.error("application_error", fields(args));
const warn = (...args: unknown[]) => testMode ? console.warn("[WARN]", ...args) : structuredLogger.warn("application_warning", fields(args));

export default { log, info, error, warn };
