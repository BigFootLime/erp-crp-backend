// src/module/admin/validators/admin.validators.ts
import { z } from "zod";

export const resetPasswordByAdminSchema = z.object({
  params: z.object({
    id: z.string().min(1), // your users ids might be uuid or int; keep string to match your other controllers
  }),
  body: z.object({
    token: z.string().min(10, "Token invalide."),
    newPassword: z
      .string()
      .min(10, "Le mot de passe doit faire au moins 10 caractères.")
      .regex(/[A-Z]/, "Le mot de passe doit contenir au moins 1 majuscule.")
      .regex(/[a-z]/, "Le mot de passe doit contenir au moins 1 minuscule.")
      .regex(/[0-9]/, "Le mot de passe doit contenir au moins 1 chiffre.")
      .regex(/[^A-Za-z0-9]/, "Le mot de passe doit contenir au moins 1 symbole."),
  }),
});

export type ResetPasswordByAdminDTO = z.infer<typeof resetPasswordByAdminSchema>;
