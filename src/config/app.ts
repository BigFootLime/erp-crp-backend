import express from "express";
import swaggerUi from "swagger-ui-express";
import path from "path";
import cors from "cors";
import helmet from "helmet";
import v1Router from "../routes/v1.routes";
import { errorHandler } from "../middlewares/errorHandler";
import { checkNetworkDrive } from "../utils/checkNetworkDrive";
import { swaggerSpec } from "../swagger/swagger";
import { validationErrorMiddleware } from "../module/auth/middlewares/validationError.middleware";
import { requestIdMiddleware } from "../middlewares/requestId";
import { requestLogger } from "../middlewares/requestLogger";
import { stripQueryFromUrl } from "../utils/logPath";
import pool from "./database";
import { resolveTrustProxySetting } from "./trust-proxy";
import { getRealtimeReadiness } from "../sockets/sockeServer";
import { installStructuredConsole, logger } from "../shared/observability/logger";
import { createObservabilityRouter } from "../shared/observability/routes";
import { DEMO_CAPABILITIES, isDemoMode } from "./demo-mode";
import { authenticateToken } from "../module/auth/middlewares/auth.middleware";
import { isCorsOriginAllowed } from "./cors-policy";

installStructuredConsole();
const app = express();

// Reverse proxy (Nginx/Traefik) support: trust X-Forwarded-* headers.
app.set("trust proxy", resolveTrustProxySetting());

/* ------------------ 1) Sécurité & CORS ------------------ */

app.use(requestIdMiddleware);

app.use(helmet());

const defaultAllowedOrigins = [
  "https://cerp.croix-rousse-precision.fr",
  "http://cerp.croix-rousse-precision.fr",
  "http://localhost:5173",
  "http://localhost:5137",
  "http://localhost:4173",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:5137",
  "http://127.0.0.1:4173",
  "app://cerp",
];

const envOrigins = (process.env.CORS_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (isDemoMode() && envOrigins.length === 0) {
  throw new Error("[demo] CORS_ORIGINS must contain the demo frontend origin");
}

const staticAllowedOrigins = new Set<string>(isDemoMode() ? envOrigins : defaultAllowedOrigins);
if (!isDemoMode()) {
  for (const o of envOrigins) staticAllowedOrigins.add(o);
}

const isAllowedOrigin = (origin: string): boolean => isCorsOriginAllowed(origin, staticAllowedOrigins, isDemoMode());

const corsOptionsDelegate: cors.CorsOptionsDelegate = (req, cb) => {
  const originHeader = req.headers.origin;
  const origin = typeof originHeader === "string" ? originHeader : undefined;
  const allowed = !!origin && isAllowedOrigin(origin);

  const requestId =
    typeof (req as unknown as { requestId?: unknown }).requestId === "string"
      ? ((req as unknown as { requestId?: string }).requestId ?? null)
      : null;
  const reqPath = stripQueryFromUrl(
    typeof (req as unknown as { originalUrl?: unknown }).originalUrl === "string"
      ? (req as unknown as { originalUrl: string }).originalUrl
      : typeof (req as unknown as { url?: unknown }).url === "string"
        ? (req as unknown as { url: string }).url
        : null
  );

  if (origin && !allowed) {
    logger.warn("cors_request_rejected", {
      request_id: requestId,
      http_method: req.method,
      http_route: reqPath ?? null,
    });
  }

  cb(null, {
    origin: allowed ? origin : false,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-CERP-Database",
      "X-Request-Id",
      "X-Correlation-Id",
      "X-Page-Key",
      "X-Client-Session-Id",
      "X-Session-Id",
      "Idempotency-Key",
    ],
    exposedHeaders: [
      "X-Request-Id",
      "X-Correlation-Id",
      "Content-Disposition",
      "X-CERP-Document-SHA256",
    ],
    optionsSuccessStatus: 204,
  });
};

app.use(cors(corsOptionsDelegate));
app.options("*", cors(corsOptionsDelegate));

app.use(requestLogger);

// Logger — format "dev" mais avec l'URL débarrassée de sa query string :
// morgan(":url") rejouerait les PII des recherches (?q=email, ?siret=...) dans
// la console, y compris en prod où NODE_ENV vaut "development" (cf. errorHandler).

/* --------- 2) Parsers: JSON + urlencoded (sans casser multipart) --------- */

// 👇 Parser JSON UNIQUEMENT si Content-Type = application/json
const jsonParser = express.json({
  limit: "10mb",
  verify: (req, _res, buffer) => {
    const expressRequest = req as express.Request;
    if (expressRequest.originalUrl.startsWith("/api/v1/electronic-invoicing/webhooks/")) {
      expressRequest.rawBody = Buffer.from(buffer);
    }
  },
});

app.use((req, res, next) => {
  if (req.is("application/json")) {
    return jsonParser(req, res, next);
  }
  return next();
});

// Formulaires classiques (x-www-form-urlencoded)
app.use(
  express.urlencoded({
    extended: true,
    limit: "10mb",
  })
);

/* ------------------ 3) Swagger / Docs ------------------ */

if (!isDemoMode()) {
  app.use(
    "/docs",
    swaggerUi.serve,
    swaggerUi.setup(swaggerSpec, {
      swaggerOptions: { persistAuthorization: true },
    })
  );
}

/* ------------------ 4) Routes ------------------ */

app.get("/", (_req, res) => {
  res.send("✅ Backend CERP en ligne !");
});

app.get("/api/v1", (_req, res) => {
  res.send("✅ Backend CERP en ligne en V1 !");
});

// Environnement runtime (public) — source de vérité pour le badge front.
// Renvoie la base RÉELLEMENT connectée (SELECT current_database()), impossible à mentir :
// permet à l'UI d'afficher "cerp_test" quand l'API sert la base de test, et non la sélection front.
app.get("/api/v1/environment", (req, res, next) => {
  // A demo session may only attest its own dedicated environment. Production
  // keeps this legacy endpoint public for compatibility.
  if (!isDemoMode()) return next();
  return authenticateToken(req, res, next);
}, async (req, res) => {
  if (isDemoMode() && req.headers["x-cerp-database"] !== "cerp_demo") {
    res.status(403).json({ error: "DEMO_RESTRICTED", message: "Cette action n'est pas disponible dans la démo." });
    return;
  }
  try {
    const { rows } = await pool.query<{ database: string }>(
      "SELECT current_database() AS database"
    );
    const database = rows[0]?.database ?? null;
    const environment =
      isDemoMode() && database === "cerp_demo"
        ? "demo"
        : database === "cerp_prod"
        ? "production"
        : database === "cerp_test"
        ? "test"
        : database
        ? "other"
        : "unknown";
    res.json({
      database,
      environment,
      appEnv: process.env.NODE_ENV ?? null,
      demo: isDemoMode() && database === "cerp_demo",
      capabilities: isDemoMode() && database === "cerp_demo" ? DEMO_CAPABILITIES : undefined,
    });
  } catch {
    // Base injoignable : on ne ment pas, on répond "unknown" (le badge se masquera).
    res.status(503).json({ database: null, environment: "unknown", appEnv: process.env.NODE_ENV ?? null, demo: false });
  }
});

// Public doctor signal with booleans only: it reveals neither table ownership
// nor grants, but prevents deployments from claiming full cross-writer realtime
// readiness before the mandatory privileged backstops are installed.
app.get("/api/v1/realtime/readiness", (_req, res) => {
  const readiness = getRealtimeReadiness();
  if (isDemoMode()) {
    res.status(200).json({ ...readiness, disabled: true });
    return;
  }
  res.status(readiness.ready ? 200 : 503).json(readiness);
});

app.use(createObservabilityRouter(pool));

// Routes API v1
app.use("/api/v1/", v1Router);

/* ------------------ 5) Private operational media ------------------ */

// No /images express.static mount: CORS is not authorization. Media files are
// delivered only by the authenticated, audited
// /api/v1/operational-media/:assetId/content route.

app.use(validationErrorMiddleware);


logger.info("image_storage_configured", { delivery: "authenticated_operational_media" });

// Vérifie que le dossier réseau est bien monté
if (!isDemoMode()) {
  checkNetworkDrive().catch(() => {
    logger.error("image_storage_unavailable", { affected_scope: "product_images" });
  });
}

/* ------------------ 6) Error handler (TOUJOURS EN DERNIER) ------------------ */

app.use(errorHandler);

export default app;
