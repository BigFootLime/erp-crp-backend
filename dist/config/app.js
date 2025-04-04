"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
// import { swaggerSpec } from '../docs/swagger';
const cors_1 = __importDefault(require("cors"));
const helmet_1 = __importDefault(require("helmet"));
const morgan_1 = __importDefault(require("morgan"));
const v1_routes_1 = __importDefault(require("../routes/v1.routes"));
const errorHandler_1 = require("../middlewares/errorHandler");
const app = (0, express_1.default)();
// 🔐 Sécurité HTTP
app.use((0, helmet_1.default)());
// app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
// 🌐 Autoriser CORS
app.use((0, cors_1.default)());
// 🔍 Logger des requêtes
app.use((0, morgan_1.default)('dev'));
// 🔄 Parsing JSON
app.use(express_1.default.json());
// 🔄 Parsing des URL
app.use(errorHandler_1.errorHandler);
// Exemple route de test
app.get('/', (req, res) => {
    res.send('✅ Backend ERP en ligne !');
});
app.get('/api/v1', (req, res) => {
    res.send('✅ Backend ERP en ligne en V1 !');
});
// 🌍 Point d’entrée versionné
app.use('/api/v1/', v1_routes_1.default); // ✅ RESTful + versionné
app.use('/images', express_1.default.static('S:/CRP_SYSTEMS/images'));
exports.default = app;
