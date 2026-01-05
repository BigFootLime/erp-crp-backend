import { z } from "zod";
import { trimString } from "./_helpers";

export const loginSchema = z.object({
  username: trimString(3, "Nom d'utilisateur requis (min 3 caractères)")
    .transform(v => v.toUpperCase()), // si tu veux forcer "UTILISATEUR" style ERP
  password: z
    .string({ required_error: "Mot de passe requis" })
    .min(1, "Mot de passe requis"),
}).strict();

export type LoginDTO = z.infer<typeof loginSchema>;
