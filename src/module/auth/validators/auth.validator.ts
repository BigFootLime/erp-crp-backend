import { z } from "zod";
import { trimString } from "./_helpers";
import { strongPasswordReset } from "./_helpers";
import {
  canonicalizeAuthUsername,
  preserveOpaqueAuthToken,
} from "../domain/auth-identity";

export const loginSchema = z.object({
  username: trimString(3, "Nom d'utilisateur requis (min 3 caractères)")
    .transform(canonicalizeAuthUsername),
  password: z
    .string({ required_error: "Mot de passe requis" })
    .min(1, "Mot de passe requis"),
  database: z.enum(["cerp_prod", "cerp_test"]).optional(),
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
      .min(1, "Token requis")
      .max(256, "Token invalide")
      .transform(preserveOpaqueAuthToken),
    newPassword: strongPasswordReset,
  })
  .strict();

export type ResetPasswordDTO = z.infer<typeof resetPasswordSchema>;

export const activateAccountSchema = z
  .object({
    token: z
      .string({ required_error: "Invitation requise" })
      .min(1, "Invitation requise")
      .max(2048, "Invitation invalide")
      .transform(preserveOpaqueAuthToken),
    newPassword: strongPasswordReset,
  })
  .strict();

export type ActivateAccountDTO = z.infer<typeof activateAccountSchema>;
