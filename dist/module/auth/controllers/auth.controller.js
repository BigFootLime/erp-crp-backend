"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.login = exports.register = void 0;
const user_validator_1 = require("../validators/user.validator");
const auth_service_1 = require("../services/auth.service");
const auth_validator_1 = require("../validators/auth.validator");
const auth_service_2 = require("../services/auth.service");
const asyncHandler_1 = require("../../../utils/asyncHandler");
exports.register = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const validated = user_validator_1.registerSchema.parse(req.body);
    if (validated.employment_end_date &&
        validated.employment_date &&
        new Date(validated.employment_end_date) <= new Date(validated.employment_date)) {
        return res.status(400).json({
            error: "La date de fin d’emploi doit être postérieure à la date d’embauche"
        });
    }
    const user = await (0, auth_service_1.registerUser)(validated);
    return res.status(201).json({
        message: 'Utilisateur créé avec succès',
        user,
    });
});
// 📌 Connexion utilisateur
exports.login = (0, asyncHandler_1.asyncHandler)(async (req, res) => {
    const { email, password } = auth_validator_1.loginSchema.parse(req.body);
    const data = await (0, auth_service_2.loginUser)(email, password);
    return res.status(200).json({
        message: "Connexion réussie",
        ...data
    });
});
