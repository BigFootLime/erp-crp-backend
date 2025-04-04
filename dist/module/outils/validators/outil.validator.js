"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.outilSchema = void 0;
const zod_1 = require("zod");
// 🧪 Schéma Zod validant un outil à créer
exports.outilSchema = zod_1.z.object({
    id_fabricant: zod_1.z.number().int(),
    id_famille: zod_1.z.number().int(),
    id_geometrie: zod_1.z.number().int().nullable().optional(),
    codification: zod_1.z.string().min(1),
    designation: zod_1.z.string().min(1),
    reference_fabricant: zod_1.z.string().optional(),
    profondeur_utile: zod_1.z.number().nullable().optional(),
    matiere_usiner: zod_1.z.string().optional(),
    utilisation: zod_1.z.string().optional(),
    longueur_coupe: zod_1.z.number().nullable().optional(),
    longueur_detalonnee: zod_1.z.number().nullable().optional(),
    longueur_totale: zod_1.z.number().nullable().optional(),
    diametre_nominal: zod_1.z.number().nullable().optional(),
    diametre_queue: zod_1.z.number().nullable().optional(),
    diametre_trou: zod_1.z.number().nullable().optional(),
    diametre_detalonnee: zod_1.z.number().nullable().optional(),
    angle_helice: zod_1.z.number().nullable().optional(),
    angle_pointe: zod_1.z.number().nullable().optional(),
    angle_filetage: zod_1.z.number().nullable().optional(),
    norme_filetage: zod_1.z.string().nullable().optional(),
    pas_filetage: zod_1.z.number().nullable().optional(),
    type_arrosage: zod_1.z.string().nullable().optional(),
    type_entree: zod_1.z.string().nullable().optional(),
    nombre_dents: zod_1.z.number().nullable().optional(),
    fournisseurs: zod_1.z.array(zod_1.z.number().int()).optional(),
    prixFournisseurs: zod_1.z.record(zod_1.z.string(), zod_1.z.number()).optional(),
    revetements: zod_1.z.array(zod_1.z.number().int()).optional(),
    aretes: zod_1.z.array(zod_1.z.number().int()).optional(),
    valeurs_aretes: zod_1.z.array(zod_1.z.object({
        id_arete_coupe: zod_1.z.number().int(),
        valeur: zod_1.z.number(),
    })).optional(),
});
