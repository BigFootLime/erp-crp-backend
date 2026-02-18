import { z } from "zod";
import { trimString } from "./_helpers";
import { strongPasswordReset } from "./_helpers";

export const loginSchema = z.object({
  username: trimString(3, "Nom d'utilisateur requis (min 3 caractères)")
    .transform(v => v.toUpperCase()), // si tu veux forcer "UTILISATEUR" style ERP
  password: z
    .string({ required_error: "Mot de passe requis" })
    .min(1, "Mot de passe requis"),
}).strict();

export type LoginDTO = z.infer<typeof loginSchema>;

export const forgotPasswordSchema = z
  .object({
    usernameOrEmail: z.string({ required_error: "Email ou username requis" }).trim().min(1).max(254),
  })
  .strict();

export type ForgotPasswordDTO = z.infer<typeof forgotPasswordSchema>;

export const resetPasswordSchema = z
  .object({
    token: z
      .string({ required_error: "Token requis" })
      .trim()
      .min(1, "Token requis")
      .max(256, "Token invalide"),
    newPassword: strongPasswordReset,
  })
  .strict();

export type ResetPasswordDTO = z.infer<typeof resetPasswordSchema>;
