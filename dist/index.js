"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const app_1 = __importDefault(require("./config/app"));
const dotenv_1 = __importDefault(require("dotenv"));
// Chargement des variables d'environnement
dotenv_1.default.config();
const PORT = process.env.PORT || 5000;
app_1.default.listen(PORT, () => {
    console.log(`🚀 Serveur ERP lancé sur http://localhost:${PORT}`);
});
