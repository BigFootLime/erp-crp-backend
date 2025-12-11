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
import { apiReference } from "@scalar/express-api-reference";

const app = express();

/* ------------------ 1) Sécurité & CORS ------------------ */

app.use(helmet());

app.use(
  cors({
    origin: "*", // ou ton domaine précis si tu veux
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    credentials: true,
  })
);

// Logger
app.use(morgan("dev"));

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

app.use("/reference", apiReference({ spec: { content: swaggerSpec } }));

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
  express.static(imagePath, {
    setHeaders: (res, filePath) => {
      const mimeType = mime.lookup(filePath);
      if (mimeType) {
        res.setHeader("Content-Type", mimeType);
      }
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    },
  })
);

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
