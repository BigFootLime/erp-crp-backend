"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.loginUser = exports.registerUser = void 0;
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const auth_repository_1 = require("../repository/auth.repository");
const auth_repository_2 = require("../repository/auth.repository");
const registerUser = async (data) => {
    // 🔐 Hash du mot de passe
    const salt = await bcryptjs_1.default.genSalt(10);
    const hashedPassword = await bcryptjs_1.default.hash(data.password, salt);
    // 📤 Enregistrement en base
    const user = await (0, auth_repository_1.createUser)(data, hashedPassword);
    return user;
};
exports.registerUser = registerUser;
const loginUser = async (email, password) => {
    const user = await (0, auth_repository_2.findUserByEmail)(email);
    if (!user) {
        throw new Error("Email ou mot de passe incorrect");
    }
    const isMatch = await bcryptjs_1.default.compare(password, user.password);
    if (!isMatch) {
        throw new Error("Email ou mot de passe incorrect");
    }
    // 🔐 Génération du JWT
    const token = jsonwebtoken_1.default.sign({
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
    }, process.env.JWT_SECRET, { expiresIn: '1d' });
    return {
        token,
        user: {
            id: user.id,
            username: user.username,
            email: user.email,
            role: user.role,
        },
    };
};
exports.loginUser = loginUser;
