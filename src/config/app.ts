import express from 'express';
import swaggerUi from 'swagger-ui-express';
import path from 'path';
// import { swaggerSpec } from '../docs/swagger';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import v1Router from '../routes/v1.routes';
import { errorHandler } from '../middlewares/errorHandler';

const app = express();

// 🔐 Sécurité HTTP
app.use(helmet());

// app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// 🌐 Autoriser CORS
app.use(cors());

// 🔍 Logger des requêtes
app.use(morgan('dev'));

// 🔄 Parsing JSON
app.use(express.json());

// 🔄 Parsing des URL
app.use(errorHandler);

// Exemple route de test
app.get('/', (req, res) => {
  res.send('✅ Backend ERP en ligne !');
});
app.get('/api/v1', (req, res) => {
  res.send('✅ Backend ERP en ligne en V1 !');
});
// 🌍 Point d’entrée versionné
app.use('/api/v1/', v1Router); // ✅ RESTful + versionné

app.use('/images', express.static('S:/CRP_SYSTEMS/images'));


export default app;
