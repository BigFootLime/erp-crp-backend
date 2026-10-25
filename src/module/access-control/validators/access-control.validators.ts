// src/module/access-control/validators/access-control.validators.ts
import { z } from "zod";

const moduleKeyParam = z
  .string({ error: (issue) => issue.input === undefined ? "Clé de module requise" : "Clé de module invalide" })
  .trim()
  .min(1, "Clé de module requise")
  .max(64, "Clé de module invalide")
  .regex(/^[a-z0-9-]+$/, "Clé de module invalide");

const userIdParam = z
  .string({ error: (issue) => issue.input === undefined ? "ID utilisateur requis" : "ID utilisateur invalide" })
  .trim()
  .regex(/^\d+$/, "ID utilisateur invalide");

const accessDecision = z.enum(["GRANTED", "DENIED"], {
  error: () => ({ message: "Décision d'accès invalide (GRANTED ou DENIED)" }),
});

export const setModuleDefaultSchema = z.object({
  params: z.object({ moduleKey: moduleKeyParam }),
  body: z
    .object({
      enabled_by_default: z.boolean({
        error: (issue) => issue.input === undefined ? "Valeur par défaut requise" : "Valeur par défaut invalide",
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
  body: z.object({ confirm: z.string({ error: "Confirmation requise" }) }).strict(),
});
export type UnlockAllDTO = z.infer<typeof unlockAllSchema>;

export const listAccessEventsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
  user_id: z.coerce.number().int().positive().optional(),
  module_key: moduleKeyParam.optional(),
});
export type ListAccessEventsQueryDTO = z.infer<typeof listAccessEventsQuerySchema>;

const reviewIdParam = z.string().guid("Identifiant de revue invalide");

export const createAccessReviewSchema = z.object({
  body: z
    .object({
      inactivity_days: z.number().int().min(30).max(730).default(90),
      login_failure_window_days: z.number().int().min(1).max(90).default(30),
      failed_login_threshold: z.number().int().min(1).max(100).default(5),
      due_in_days: z.number().int().min(1).max(90).default(14),
    })
    .strict(),
});

export const listAccessReviewsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
});

export const accessReviewIdSchema = z.object({ reviewId: reviewIdParam });

export const decideAccessReviewItemSchema = z.object({
  params: z.object({ reviewId: reviewIdParam, userId: userIdParam }),
  body: z
    .object({
      decision: z.enum(["CONFIRMED", "CHANGE_REQUIRED", "EXCEPTION_ACCEPTED"]),
      rationale: z.string().trim().max(1000).nullable().optional().default(null),
    })
    .strict()
    .superRefine((value, ctx) => {
      if (value.decision !== "CONFIRMED" && !value.rationale) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["rationale"],
          message: "Une justification est requise pour une correction ou une exception.",
        });
      }
    }),
});
