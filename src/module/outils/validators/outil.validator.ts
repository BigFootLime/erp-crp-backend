import { z } from "zod";

// 🧪 Schéma Zod validant un outil à créer
export const outilSchema = z.object({
    id_fabricant: z.number().int(),
    id_famille: z.number().int(),
    id_geometrie: z.number().int().nullable().optional(),
    codification: z.string().min(1),
    designation_outil_cnc: z.string().min(1),
    reference_fabricant: z.string().optional(),
    profondeur_utile: z.number().nullable().optional(),
    matiere_usiner: z.string().nullable().optional(),
    utilisation: z.string().nullable().optional(),
    longueur_coupe: z.number().nullable().optional(),
    longueur_detalonnee: z.number().nullable().optional(),
    longueur_totale: z.number().nullable().optional(),
    diametre_nominal: z.number().nullable().optional(),
    diametre_queue: z.number().nullable().optional(),
    diametre_trou: z.number().nullable().optional(),
    diametre_detalonnee: z.number().nullable().optional(),
    angle_helice: z.number().nullable().optional(),
    angle_pointe: z.number().nullable().optional(),
    angle_filetage: z.number().nullable().optional(),
    norme_filetage: z.string().nullable().optional(),
    pas_filetage: z.number().nullable().optional(),
    type_arrosage: z.string().nullable().optional(),
    type_entree: z.string().nullable().optional(),
    nombre_dents: z.number().nullable().optional(),
    fournisseurs: z.array(z.number().int()).optional(),
    prixFournisseurs: z.record(z.string(), z.number()).optional(),
    revetements: z.array(z.number().int()).optional(),
    aretes: z.array(z.number().int()).optional(),
    valeurs_aretes: z.array(
        z.object({
            id_arete_coupe: z.number().int(),
            valeur: z.number(),
        })
    ).optional(),
    quantite_stock: z.number().int().nonnegative().optional().default(0),
quantite_minimale: z.number().int().nonnegative().optional().default(0),

});

// 🎯 Typage direct depuis Zod
export type CreateOutilInput = z.infer<typeof outilSchema>;
