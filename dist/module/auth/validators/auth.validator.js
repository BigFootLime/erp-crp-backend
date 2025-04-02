"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.loginSchema = void 0;
const zod_1 = require("zod");
// 🧾 Schéma de validation pour la connexion
exports.loginSchema = zod_1.z.object({
    email: zod_1.z.string().email({ message: 'Email invalide' }),
    password: zod_1.z.string().min(6, { message: 'Mot de passe trop court' }),
});
