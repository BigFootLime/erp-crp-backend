// src/module/access-control/validators/access-control.validators.ts
import { z } from "zod";

const moduleKeyParam = z
  .string({ required_error: "Clé de module requise", invalid_type_error: "Clé de module invalide" })
  .trim()
  .min(1, "Clé de module requise")
  .max(64, "Clé de module invalide")
  .regex(/^[a-z0-9-]+$/, "Clé de module invalide");

const userIdParam = z
  .string({ required_error: "ID utilisateur requis", invalid_type_error: "ID utilisateur invalide" })
  .trim()
  .regex(/^\d+$/, "ID utilisateur invalide");

const accessDecision = z.enum(["GRANTED", "DENIED", "INHERIT"], {
  errorMap: () => ({ message: "Décision d'accès invalide (GRANTED, DENIED ou INHERIT)" }),
});

export const setModuleDefaultSchema = z.object({
  params: z.object({ moduleKey: moduleKeyParam }),
  body: z
    .object({
      enabled_by_default: z.boolean({
        required_error: "Valeur par défaut requise",
        invalid_type_error: "Valeur par défaut invalide",
      }),
    })
    .strict(),
});
export type SetModuleDefaultDTO = z.infer<typeof setModuleDefaultSchema>;

export const setUserModuleAccessSchema = z.object({
  params: z.object({ userId: userIdParam, moduleKey: moduleKeyParam }),
  body: z.object({ access: accessDecision }).strict(),
});
export type SetUserModuleAccessDTO = z.infer<typeof setUserModuleAccessSchema>;

export const setUserModulesBulkSchema = z.object({
  params: z.object({ userId: userIdParam }),
  body: z
    .object({
      entries: z
        .array(z.object({ module_key: moduleKeyParam, access: accessDecision }).strict())
        .min(1, "Au moins une décision est requise")
        .max(100, "Trop de décisions dans un même envoi")
        // Deux décisions contradictoires sur le même module rendraient le
        // résultat dépendant de l'ordre : on refuse plutôt que d'arbitrer.
        .refine(
          (entries) => new Set(entries.map((entry) => entry.module_key)).size === entries.length,
          "Un même module ne peut apparaître qu'une fois"
        ),
    })
    .strict(),
});
export type SetUserModulesBulkDTO = z.infer<typeof setUserModulesBulkSchema>;

export const unlockAllSchema = z.object({
  body: z.object({ confirm: z.string({ required_error: "Confirmation requise" }) }).strict(),
});
export type UnlockAllDTO = z.infer<typeof unlockAllSchema>;

export const listAccessEventsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
  user_id: z.coerce.number().int().positive().optional(),
  module_key: moduleKeyParam.optional(),
});
export type ListAccessEventsQueryDTO = z.infer<typeof listAccessEventsQuerySchema>;
