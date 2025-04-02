"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerSchema = void 0;
const zod_1 = require("zod");
// Rôles autorisés
const roles = [
    'Directeur',
    'Employee',
    'Administrateur Systeme et Reseau',
    'Responsable Qualité',
    'Secretaire',
    'Responsable Programmation'
];
const genders = ['Male', 'Female'];
const statuses = ['Active', 'Inactive', 'Suspended'];
exports.registerSchema = zod_1.z.object({
    username: zod_1.z.string().min(3),
    password: zod_1.z.string().min(6),
    name: zod_1.z.string(),
    surname: zod_1.z.string(),
    email: zod_1.z.string().email(),
    // ✅ Téléphone au format français (+33 suivi de 9 chiffres)
    tel_no: zod_1.z.string().regex(/^\+33[1-9][0-9]{8}$/, {
        message: "Le numéro doit être au format +33XXXXXXXXX",
    }),
    gender: zod_1.z.enum(genders, {
        errorMap: () => ({ message: "Le genre doit être 'Male' ou 'Female'" })
    }),
    address: zod_1.z.string(),
    lane: zod_1.z.string(),
    house_no: zod_1.z.string(),
    postcode: zod_1.z.string().regex(/^\d{5}$/, {
        message: "Le code postal doit contenir 5 chiffres"
    }),
    country: zod_1.z.literal('France', {
        errorMap: () => ({ message: "Le pays doit être 'France'" })
    }),
    salary: zod_1.z.number().min(0, {
        message: "Le salaire doit être un nombre positif"
    }),
    date_of_birth: zod_1.z.string(), // format YYYY-MM-DD
    // ✅ Role strictement contrôlé
    role: zod_1.z.enum(roles, {
        errorMap: () => ({
            message: "Le rôle n'est pas autorisé"
        })
    }),
    social_security_number: zod_1.z.string().length(15, {
        message: "Le numéro de sécurité sociale doit contenir 15 chiffres"
    }),
    // ✅ Statut optionnel mais vérifié si présent
    status: zod_1.z.enum(statuses).optional(),
    // Dates optionnelles mais validables ensuite
    employment_date: zod_1.z.string().optional(),
    employment_end_date: zod_1.z.string().optional()
});
