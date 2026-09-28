import type { NextFunction, Request, Response } from "express";

import { isDemoMode } from "../config/demo-mode";

const READ_PREFIXES = [
  "/clients", "/devis", "/affaires", "/commandes", "/stock", "/production",
  "/planning", "/fournisseurs", "/pieces-techniques", "/pieces-families", "/gammes",
  "/methodes", "/finitions", "/centre-frais", "/outils", "/codes", "/service-status",
  "/dashboard-governance", "/qualite", "/quality-360", "/metrologie", "/metrology-360",
  "/livraisons", "/production-readiness", "/procurement-reliability", "/replenishment-proposals",
  "/notifications",
];

// Quote creation loads only these small reference lists. Keep the exception
// list exact: it must not turn the whole billing or document namespaces into
// a demo-readable surface.
const SAFE_EXACT_READ_PATHS = new Set([
  "/billers", "/payment-modes", "/conditions-paiement", "/compte-vente",
  "/service-status/documents", "/operational-media/capabilities",
]);

// A GET can still generate, export or disclose a retained document. These
// route segments are denied before the broad catalogue read allowlist.
const SENSITIVE_READ_SEGMENTS = new Set([
  "documents", "document", "official-documents", "creation-snapshot", "file", "download",
  "export.csv", "exports", "pdf", "print", "print-intents", "preview", "pack", "proofs",
  "operational-media", "audit-logs", "users", "banking-info", "accounting-exports",
  // These endpoints perform an action despite a route name which can otherwise
  // look safe when inspected only by HTTP verb.
  "generate", "refresh", "retry", "freeze", "revoke", "confirm", "reset", "ship",
]);

function hasSensitiveReadSegment(path: string): boolean {
  return path
    .split("/")
    .filter(Boolean)
    .some((segment) => {
      const normalized = segment.toLowerCase();
      return SENSITIVE_READ_SEGMENTS.has(normalized) || /\.(pdf|csv|xlsx|zip)$/i.test(normalized);
    });
}

function isReadAllowed(path: string): boolean {
  if (SAFE_EXACT_READ_PATHS.has(path.toLowerCase())) return true;
  return !hasSensitiveReadSegment(path) && READ_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

function isDraftDevis(req: Request): boolean {
  const status = req.body?.statut ?? req.body?.status;
  return typeof status === "string" && ["BROUILLON", "DRAFT"].includes(status.trim().toUpperCase());
}

function isSafeWrite(req: Request): boolean {
  if (req.is("multipart/form-data")) return false;
  // Native presentation writes: this is deliberately a closed list of the
  // exact forms replayed by the demo. It does not grant generic module write
  // access and remains behind JWT/RBAC plus the isolated demo database.
  if (req.method === "POST" || req.method === "PATCH" || req.method === "PUT") {
    const path = req.path;
    if (req.method === "POST" && (path === "/pieces-techniques" || path === "/pieces-techniques/drafts" || path === "/stock/articles" || path === "/livraisons" || path === "/quality-360/executions")) return true;
    if (req.method === "PUT" && /^\/pieces-techniques\/drafts\/[0-9a-f-]{36}$/.test(path)) return true;
    if (req.method === "POST" && /^\/(piece-technique-versions|pieces-techniques\/[0-9a-f-]{36}\/versions)\/[0-9a-f-]{36}\/gammes$/.test(path)) return true;
    if (req.method === "POST" && /^\/pieces-techniques\/[0-9a-f-]{36}\/versions\/[0-9a-f-]{36}\/publish$/.test(path)) return true;
    if (req.method === "POST" && /^\/gammes\/[0-9a-f-]{36}\/(operations|publish)$/.test(path)) return true;
    if (req.method === "POST" && /^\/production\/ofs\/\d+\/receipt$/.test(path)) return true;
    if (req.method === "PATCH" && /^\/production\/ofs\/\d+$/.test(path) && String(req.body?.statut ?? "").toUpperCase() === "TERMINE") return true;
    if (req.method === "POST" && /^\/livraisons\/[0-9a-f-]{36}\/(lines|prepare|confirm|ship)$/.test(path)) return true;
    if (req.method === "POST" && /^\/livraisons\/[0-9a-f-]{36}\/lines\/[0-9a-f-]{36}\/allocations$/.test(path)) return true;
    if (req.method === "POST" && /^\/quality-360\/executions\/[0-9a-f-]{36}\/(measurements|decision)$/.test(path)) return true;
  }
  if (req.method !== "POST") return false;
  // The onboarding wizard checks a name/SIREN before it creates a client.
  // This endpoint is a validated lookup; it does not persist data.
  if (req.path === "/clients" || req.path === "/clients/duplicate-check") return true;
  if (req.path === "/demo/presentation/run") return true;
  if (req.path === "/devis") return isDraftDevis(req);
  if (req.path === "/stock/movements/preview" || req.path === "/stock/intelligence/simulate") return true;

  // The operator flow uses the existing audited production-execution service.
  // It only runs against the isolated demo database; uploads, exports, stock
  // receipts and every admin path remain outside this list.
  if (req.path === "/production/execution" ||
    req.path === "/production/execution/quantities" ||
    req.path === "/production/execution/operations/finish/preview" ||
    req.path === "/production/execution/operations/finish") return true;
  if (/^\/production\/execution\/[0-9a-f-]{36}\/(pause|resume|stop)$/.test(req.path)) return true;

  // A scenario can advance only through the existing command-to-affaire
  // generator. It cannot create or mutate arbitrary customer orders.
  if (/^\/commandes\/\d+\/(affaires\/preview|generate-affaires)$/.test(req.path)) return true;
  return /^\/devis\/\d+\/convert-to-commande$/.test(req.path);
}

function rejected(res: Response): void {
  res.status(403).json({ error: "DEMO_RESTRICTED", message: "Cette action n'est pas disponible dans la démo." });
}

/** Fail-closed API boundary for the dedicated cerp_demo deployment. */
export function demoAccessGuard(req: Request, res: Response, next: NextFunction): void {
  if (!isDemoMode()) return next();
  if (req.headers["x-cerp-database"] !== "cerp_demo") return rejected(res);
  if (req.method === "DELETE") return rejected(res);
  if (req.method === "GET" || req.method === "HEAD") {
    return isReadAllowed(req.path) ? next() : rejected(res);
  }
  return isSafeWrite(req) ? next() : rejected(res);
}

/**
 * This runs before the legacy public routers. It closes only those public
 * surfaces; protected business routes must continue to reach the JWT and
 * demo-access guards mounted later in v1.routes.
 */
export function demoPublicBoundaryGuard(req: Request, res: Response, next: NextFunction): void {
  if (!isDemoMode()) return next();
  const hasDemoDatabase = req.headers["x-cerp-database"] === "cerp_demo";
  if (!hasDemoDatabase) return rejected(res);
  // Express route matching is case-insensitive by default. Normalize before
  // classifying public paths so an upper-case mount cannot skip this boundary.
  const path = req.path.toLowerCase();

  if (path === "/openapi.json" || path === "/portal" || path.startsWith("/portal/") ||
    path === "/electronic-invoicing/webhooks" || path.startsWith("/electronic-invoicing/webhooks/") ||
    path === "/terminals" || path.startsWith("/terminals/") ||
    path === "/time-clock" || path.startsWith("/time-clock/")) {
    return rejected(res);
  }

  if (path === "/auth" || path.startsWith("/auth/")) {
    const allowed =
      (req.method === "POST" && path === "/auth/login") ||
      (req.method === "POST" && path === "/auth/demo/login") ||
      (req.method === "GET" && (path === "/auth/me" || path === "/auth/access-profile"));
    return allowed ? next() : rejected(res);
  }

  return next();
}

/** Auth is mounted before the global JWT guard, so protect public reset/MFA flows here. */
export function demoAuthGuard(req: Request, res: Response, next: NextFunction): void {
  const allowedLogin = req.method === "POST" && req.path === "/login";
  const allowedDemoLogin = req.method === "POST" && req.path === "/demo/login";
  const allowedAuthenticatedRead =
    req.method === "GET" &&
    (req.path === "/me" || req.path === "/access-profile") &&
    req.headers["x-cerp-database"] === "cerp_demo";
  const allowed = allowedLogin || allowedDemoLogin || allowedAuthenticatedRead;
  if (!isDemoMode() || allowed) return next();
  rejected(res);
}
