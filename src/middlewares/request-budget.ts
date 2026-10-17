import type { Request, RequestHandler } from "express";

function boundedLimit(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  if (env[key] === undefined) return fallback;
  const value = Number(env[key]);
  if (!Number.isSafeInteger(value) || value < 1 || value > 4096) throw new Error(`${key} must be an integer between 1 and 4096`);
  return value;
}

export function isExpensiveRequest(req: Pick<Request, "headers" | "path">): boolean {
  return String(req.headers["content-type"] ?? "").toLowerCase().startsWith("multipart/form-data")
    || /(?:^|\/)(?:exports?|imports?|pdf|generate-pdf|print|preview)(?:\/|$)|\.pdf$/i.test(req.path);
}

/** Per-process admission control, before body parsing. No unbounded waiting queue. */
export function createRequestBudget(env: NodeJS.ProcessEnv = process.env): RequestHandler {
  const totalLimit = boundedLimit(env, "CERP_HTTP_MAX_IN_FLIGHT", 256);
  const heavyLimit = boundedLimit(env, "CERP_HTTP_HEAVY_MAX_IN_FLIGHT", 8);
  let active = 0;
  let heavy = 0;
  return (req, res, next) => {
    if (req.method === "OPTIONS") { next(); return; }
    const expensive = isExpensiveRequest(req);
    if (active >= totalLimit || (expensive && heavy >= heavyLimit)) {
      res.setHeader("Retry-After", "5");
      res.setHeader("Cache-Control", "no-store");
      res.status(429).json({ code: "SERVER_REQUEST_BUDGET_REACHED", message: "Le serveur traite déjà plusieurs opérations. Réessayez dans quelques secondes." });
      return;
    }
    active += 1;
    if (expensive) heavy += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      active -= 1;
      if (expensive) heavy -= 1;
      res.off("finish", release);
      res.off("close", release);
    };
    res.once("finish", release);
    res.once("close", release);
    next();
  };
}
