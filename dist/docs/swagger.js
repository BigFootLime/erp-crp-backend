"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.swaggerSpec = exports.swaggerOptions = void 0;
const swagger_jsdoc_1 = __importDefault(require("swagger-jsdoc"));
exports.swaggerOptions = {
    definition: {
        openapi: '3.0.0',
        info: {
            title: 'ERP - Croix Rousse Précision',
            version: '1.0.0',
            description: 'Documentation de l’API ERP pour la mécanique de précision',
        },
        servers: [
            {
                url: 'http://localhost:5000/api/v1',
                description: 'Serveur local',
            },
        ],
    },
    apis: ['src/docs/*.ts'], // Tous les fichiers de doc
};
exports.swaggerSpec = (0, swagger_jsdoc_1.default)(exports.swaggerOptions);
