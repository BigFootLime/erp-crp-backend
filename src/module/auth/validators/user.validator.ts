import { z } from "zod";
import { isoDate, strictEmail, strongPassword, trimString } from "./_helpers";

const roles = [
  "Directeur",
  "Employee",
  "Administrateur Systeme et Reseau",
  "Responsable Qualité",
  "Secretaire",
  "Responsable Programmation",
] as const;

const genders = ["Male", "Female"] as const;
const statuses = ["Active", "Inactive", "Suspended"] as const;

// NIR (num sécu FR) : on valide proprement (format + clé possible)
const nir = z
  .string({ required_error: "Numéro de sécurité sociale requis" })
  .trim()
  .regex(/^\d{15}$/, "Le numéro de sécurité sociale doit contenir 15 chiffres");

const phoneFR = z
  .string({ required_error: "Téléphone requis" })
  .trim()
  .regex(/^(?:\+33|0)[1-9]\d{8}$/, "Téléphone invalide (ex: 06XXXXXXXX ou +33XXXXXXXXX)");

export const registerSchema = z.object({
  username: trimString(3, "Nom d'utilisateur requis (min 3 caractères)")
    .transform(v => v.toUpperCase())
    .refine(v => /^[A-Z0-9._-]+$/.test(v), "Username: caractères autorisés A-Z 0-9 . _ -"),

  password: strongPassword,

  name: trimString(2, "Nom requis (min 2 caractères)"),
  surname: trimString(2, "Prénom requis (min 2 caractères)"),

  email: strictEmail,

  tel_no: phoneFR,

  gender: z.enum(genders, { errorMap: () => ({ message: "Le genre doit être 'Male' ou 'Female'" }) }),

  address: trimString(3, "Adresse requise"),
  lane: trimString(2, "Rue requise"),
  house_no: z.string({ required_error: "Numéro de voie requis" }).trim().min(1, "Numéro de voie requis"),

  postcode: z.string({ required_error: "Code postal requis" })
    .trim()
    .regex(/^\d{5}$/, "Le code postal doit contenir 5 chiffres"),

  country: z.literal("France", { errorMap: () => ({ message: "Le pays doit être 'France'" }) }),

  salary: z.coerce.number({ invalid_type_error: "Salaire invalide" })
    .min(0, "Le salaire doit être positif")
    .max(1_000_000, "Salaire incohérent"),

  date_of_birth: isoDate("Date de naissance")
    .refine(v => new Date(v) <= new Date(), "La date de naissance ne peut pas être dans le futur"),

  role: z.enum(roles, { errorMap: () => ({ message: "Le rôle n'est pas autorisé" }) })
    .default("Employee"),

  social_security_number: nir,

  status: z.enum(statuses).optional().default("Active"),

  employment_date: isoDate("Date d'embauche").optional(),
  employment_end_date: isoDate("Date de fin d'emploi").optional(),
})
.strict()
.superRefine((data, ctx) => {
  // ✅ règle métier dates emploi
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
});
