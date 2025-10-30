import express from 'express';
import swaggerUi from 'swagger-ui-express';
import path from 'path';
// import { swaggerSpec } from '../docs/swagger';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import v1Router from '../routes/v1.routes';
import { errorHandler } from '../middlewares/errorHandler';
import { checkNetworkDrive } from "../utils/checkNetworkDrive";
import mime from "mime-types";
import { swaggerSpec } from '../swagger/swagger';
import { apiReference } from '@scalar/express-api-reference';


const app = express();

// 🔐 Sécurité HTTP
app.use(helmet());

// app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// 🌐 Autoriser CORS
app.use(cors({
  origin: "*", // ou "*" si tu veux tout autoriser
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  credentials: true,
}));

// 🔍 Logger des requêtes
app.use(morgan('dev'));

// 🔄 Parsing JSON
app.use(express.json());

app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
  swaggerOptions: { persistAuthorization: true }, // garde le JWT après refresh
}));

app.use('/reference', apiReference({ spec: { content: swaggerSpec } }));

// 🔄 Parsing des URL
app.use(errorHandler);

// Exemple route de test
app.get('/', (req, res) => {
  res.send('✅ Backend ERP en ligne !');
});

// app.get('/health', (req, res) => {
//   res.send('✅ Backend ERP is operational !');
// });

app.get('/api/v1', (req, res) => {
  res.send('✅ Backend ERP en ligne en V1 !');
});
// 🌍 Point d’entrée versionné
app.use('/api/v1/', v1Router); // ✅ RESTful + versionné


const isLocal = process.env.NODE_ENV === "development";

const reseauPath = path.resolve("/home/bigfootlime/erp-crp/erp-crp-backend/uploads/images");
const localPath = path.resolve("uploads/images");
const imagePath = isLocal ? localPath : reseauPath;

app.use("/images", express.static(imagePath, {
  setHeaders: (res, filePath) => {
    const mimeType = mime.lookup(filePath);
    if (mimeType) {
      res.setHeader("Content-Type", mimeType);
    }
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  }
}));

console.log("📂 Dossier exposé pour les images :", imagePath);

// Vérifie que le dossier est bien accessible
checkNetworkDrive().catch(() => {
  console.error("🚨 Le dossier réseau est inaccessible. Le serveur démarre quand même, mais les images ne seront pas servies.");
});


export default app;
