import { z } from "zod";

export const trimString = (min: number, message: string) =>
  z.string({ required_error: message, invalid_type_error: message })
    .transform(v => (typeof v === "string" ? v.trim() : v))
    .refine(v => v.length >= min, { message });

export const strictEmail = z
  .string({ required_error: "Email requis", invalid_type_error: "Email invalide" })
  .trim()
  .toLowerCase()
  .email("Email invalide");

export const strongPassword = z
  .string({ required_error: "Mot de passe requis", invalid_type_error: "Mot de passe invalide" })
  .min(8, "Mot de passe : minimum 8 caractères")
  .max(72, "Mot de passe trop long (max 72)")
  .refine(v => /[A-Z]/.test(v), "Mot de passe : 1 majuscule requise")
  .refine(v => /[a-z]/.test(v), "Mot de passe : 1 minuscule requise")
  .refine(v => /\d/.test(v), "Mot de passe : 1 chiffre requis")
  .refine(v => /[^\w\s]/.test(v), "Mot de passe : 1 caractère spécial requis");

export const isoDate = (fieldName: string) =>
  z.string({ required_error: `${fieldName} requis`, invalid_type_error: `${fieldName} invalide` })
    .trim()
    .refine(v => /^\d{4}-\d{2}-\d{2}$/.test(v), `${fieldName} doit être au format YYYY-MM-DD`)
    .refine(v => !Number.isNaN(Date.parse(v)), `${fieldName} invalide`);
