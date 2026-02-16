// src/module/admin/validators/admin.validators.ts
import { z } from "zod";
import { isoDate, strictEmail, trimString } from "../../auth/validators/_helpers";

const userIdParam = z
  .string({ required_error: "ID utilisateur requis", invalid_type_error: "ID utilisateur invalide" })
  .trim()
  .regex(/^\d+$/, "ID utilisateur invalide");

const usernameSchema = trimString(3, "Nom d'utilisateur requis (min 3 caractères)")
  .transform((v) => v.toUpperCase())
  .refine((v) => /^[A-Z0-9._-]+$/.test(v), "Username: caractères autorisés A-Z 0-9 . _ -");

const phoneFR = z
  .string({ required_error: "Téléphone requis", invalid_type_error: "Téléphone invalide" })
  .trim()
  .regex(/^(?:\+33|0)[1-9]\d{8}$/, "Téléphone invalide (ex: 06XXXXXXXX ou +33XXXXXXXXX)");

const nir = z
  .string({ required_error: "Numéro de sécurité sociale requis", invalid_type_error: "Numéro de sécurité sociale invalide" })
  .trim()
  .regex(/^\d{15}$/, "Le numéro de sécurité sociale doit contenir 15 chiffres");

const genders = ["Male", "Female"] as const;
const statuses = ["Active", "Inactive", "Blocked", "Suspended"] as const;

export const adminNewPasswordSchema = z
  .string({ required_error: "Mot de passe requis", invalid_type_error: "Mot de passe invalide" })
  .min(10, "Le mot de passe doit faire au moins 10 caractères.")
  .regex(/[A-Z]/, "Le mot de passe doit contenir au moins 1 majuscule.")
  .regex(/[a-z]/, "Le mot de passe doit contenir au moins 1 minuscule.")
  .regex(/[0-9]/, "Le mot de passe doit contenir au moins 1 chiffre.")
  .regex(/[^A-Za-z0-9]/, "Le mot de passe doit contenir au moins 1 symbole.");

export const adminUserIdParamSchema = z.object({
  params: z.object({
    id: userIdParam,
  }),
});

const userCoreObject = z
  .object({
    username: usernameSchema,
    name: trimString(2, "Nom requis (min 2 caractères)"),
    surname: trimString(2, "Prénom requis (min 2 caractères)"),
    email: strictEmail,
    tel_no: phoneFR,
    role: trimString(2, "Rôle requis"),
    gender: z.enum(genders, { errorMap: () => ({ message: "Le genre doit être 'Male' ou 'Female'" }) }),
    address: trimString(3, "Adresse requise"),
    lane: trimString(2, "Rue requise"),
    house_no: z.string({ required_error: "Numéro de voie requis" }).trim().min(1, "Numéro de voie requis"),
    postcode: z
      .string({ required_error: "Code postal requis" })
      .trim()
      .regex(/^\d{5}$/, "Le code postal doit contenir 5 chiffres"),
    country: z.string().trim().min(1).optional().default("France"),
    salary: z
      .union([
        z.coerce
          .number({ invalid_type_error: "Salaire invalide" })
          .min(0, "Le salaire doit être positif")
          .max(1_000_000, "Salaire incohérent"),
        z.null(),
      ])
      .optional(),
    date_of_birth: isoDate("Date de naissance").refine(
      (v) => new Date(v) <= new Date(),
      "La date de naissance ne peut pas être dans le futur"
    ),
    employment_date: isoDate("Date d'embauche").optional().nullable(),
    employment_end_date: isoDate("Date de fin d'emploi").optional().nullable(),
    national_id: z.string().trim().min(1).optional().nullable(),
    status: z.enum(statuses).optional(),
    social_security_number: nir,
  })
  .strict();

function refineEmploymentDates(
  data: { employment_date?: string | null; employment_end_date?: string | null },
  ctx: z.RefinementCtx
) {
  if (data.employment_date && data.employment_end_date) {
    const start = new Date(data.employment_date);
    const end = new Date(data.employment_end_date);
    if (end <= start) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["employment_end_date"],
        message: "La date de fin d’emploi doit être postérieure à la date d’embauche",
      });
    }
  }
}

const userCreateBody = userCoreObject
  .extend({
    password: adminNewPasswordSchema,
  })
  .superRefine(refineEmploymentDates);

const userPatchBody = userCoreObject.partial().superRefine(refineEmploymentDates);

export const adminCreateUserSchema = z.object({
  body: userCreateBody,
});
export type AdminCreateUserDTO = z.infer<typeof adminCreateUserSchema>;

export const adminUpdateUserSchema = z
  .object({
    params: z.object({ id: userIdParam }),
    body: userPatchBody,
  })
  .superRefine((data, ctx) => {
    if (Object.keys(data.body ?? {}).length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "No fields to update" });
    }
  });
export type AdminUpdateUserDTO = z.infer<typeof adminUpdateUserSchema>;

export const resetPasswordByAdminSchema = z.object({
  params: z.object({ id: userIdParam }),
  body: z.object({
    token: z.string().min(10, "Token invalide."),
    newPassword: adminNewPasswordSchema,
  }),
});
export type ResetPasswordByAdminDTO = z.infer<typeof resetPasswordByAdminSchema>;
