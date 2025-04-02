"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_routes_1 = __importDefault(require("../module/auth/routes/auth.routes"));
// import gestionOutilsRoutes from '../modules/gestion-outils/routes/...'; // à venir
const router = (0, express_1.Router)();
// 📦 Routes versionnées par module
router.use('/auth', auth_routes_1.default);
// router.use('/gestion-outils', gestionOutilsRoutes); // à activer plus tard
exports.default = router;
