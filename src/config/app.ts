import express from "express";
import swaggerUi from "swagger-ui-express";
import path from "path";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import v1Router from "../routes/v1.routes";
import { errorHandler } from "../middlewares/errorHandler";
import { checkNetworkDrive } from "../utils/checkNetworkDrive";
import mime from "mime-types";
import { swaggerSpec } from "../swagger/swagger";
import { validationErrorMiddleware } from "../module/auth/middlewares/validationError.middleware";
import { requestIdMiddleware } from "../middlewares/requestId";
import { requestLogger } from "../middlewares/requestLogger";

const app = express();

// Reverse proxy (Nginx/Traefik) support: trust X-Forwarded-* headers.
app.set("trust proxy", 1);

/* ------------------ 1) Sécurité & CORS ------------------ */

app.use(requestIdMiddleware);

app.use(helmet());

const staticAllowedOrigins = new Set<string>([
  "https://crp-systems.croix-rousse-precision.fr",
  "http://crp-systems.croix-rousse-precision.fr",
  "http://localhost:5173",
  "http://localhost:5137",
  "http://localhost:4173",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:5137",
  "http://127.0.0.1:4173",
]);

const envOrigins = (process.env.CORS_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

for (const o of envOrigins) staticAllowedOrigins.add(o);

const isAllowedOrigin = (origin: string): boolean => {
  return staticAllowedOrigins.has(origin) || /^http:\/\/(localhost|127\.0\.0\.1):\d+$/i.test(origin);
};

const corsOptionsDelegate: cors.CorsOptionsDelegate = (req, cb) => {
  const originHeader = req.headers.origin;
  const origin = typeof originHeader === "string" ? originHeader : undefined;
  const allowed = !!origin && isAllowedOrigin(origin);

  const requestId =
    typeof (req as unknown as { requestId?: unknown }).requestId === "string"
      ? ((req as unknown as { requestId?: string }).requestId ?? null)
      : null;
  const reqPath =
    typeof (req as unknown as { originalUrl?: unknown }).originalUrl === "string"
      ? (req as unknown as { originalUrl: string }).originalUrl
      : typeof (req as unknown as { url?: unknown }).url === "string"
        ? (req as unknown as { url: string }).url
        : null;

  if (origin && !allowed) {
    console.warn(
      JSON.stringify({
        type: "cors_reject",
        requestId,
        origin,
        method: req.method,
        path: reqPath ?? null,
      })
    );
  }

  cb(null, {
    origin: allowed ? origin : false,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Request-Id"],
    exposedHeaders: ["X-Request-Id"],
    optionsSuccessStatus: 204,
  });
};

app.use(cors(corsOptionsDelegate));
app.options("*", cors(corsOptionsDelegate));

app.use(requestLogger);

// Logger
if (process.env.NODE_ENV === "development") app.use(morgan("dev"));

/* --------- 2) Parsers: JSON + urlencoded (sans casser multipart) --------- */

// 👇 Parser JSON UNIQUEMENT si Content-Type = application/json
const jsonParser = express.json({ limit: "10mb" });

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

app.use(
  "/docs",
  swaggerUi.serve,
  swaggerUi.setup(swaggerSpec, {
    swaggerOptions: { persistAuthorization: true },
  })
);

/* ------------------ 4) Routes ------------------ */

app.get("/", (_req, res) => {
  res.send("✅ Backend ERP en ligne !");
});

app.get("/api/v1", (_req, res) => {
  res.send("✅ Backend ERP en ligne en V1 !");
});

// Routes API v1
app.use("/api/v1/", v1Router);

/* ------------------ 5) Static images ------------------ */

const isLocal = process.env.NODE_ENV === "development";

const reseauPath = path.resolve(
  "/home/bigfootlime/erp-crp/erp-crp-backend/uploads/images"
);
const localPath = path.resolve("uploads/images");
const imagePath = isLocal ? localPath : reseauPath;

app.use(
  "/images",
  (req, res, next) => {
    const originHeader = req.headers.origin;
    const origin = typeof originHeader === "string" ? originHeader : undefined;

    if (origin && isAllowedOrigin(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }

    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    next();
  },
  express.static(imagePath, {
    setHeaders: (res, filePath) => {
      const mimeType = mime.lookup(filePath);
      if (mimeType) {
        res.setHeader("Content-Type", mimeType);
      }
    },
  })
);

app.use(validationErrorMiddleware);


console.log("📂 Dossier exposé pour les images :", imagePath);

// Vérifie que le dossier réseau est bien monté
checkNetworkDrive().catch(() => {
  console.error(
    "🚨 Le dossier réseau est inaccessible. Le serveur démarre quand même, mais les images ne seront pas servies."
  );
});

/* ------------------ 6) Error handler (TOUJOURS EN DERNIER) ------------------ */

app.use(errorHandler);

export default app;
