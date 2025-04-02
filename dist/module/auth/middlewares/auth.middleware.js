"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.authorizeRole = exports.authenticateToken = void 0;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
// 🔐 Vérifie le token JWT
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        res.status(401).json({ error: 'Token manquant ou invalide' });
        return;
    }
    const token = authHeader.split(' ')[1];
    try {
        const decoded = jsonwebtoken_1.default.verify(token, process.env.JWT_SECRET);
        req.user = decoded;
        next();
    }
    catch (err) {
        res.status(403).json({ error: 'Token invalide ou expiré' });
    }
};
exports.authenticateToken = authenticateToken;
// 🎯 Vérifie que l'utilisateur a un rôle autorisé
const authorizeRole = (...roles) => {
    return (req, res, next) => {
        if (!req.user) {
            res.status(401).json({ error: 'Utilisateur non authentifié' });
            return;
        }
        if (!roles.includes(req.user.role)) {
            res.status(403).json({ error: "Accès refusé : rôle insuffisant" });
            return;
        }
        next();
    };
};
exports.authorizeRole = authorizeRole;
