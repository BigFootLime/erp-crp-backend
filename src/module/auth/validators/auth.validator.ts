import { z } from 'zod';

// 🧾 Schéma de validation pour la connexion
export const loginSchema = z.object({
  username: z.string().nonempty({ message: 'Email invalide' }),
  password: z.string().min(6, { message: 'Mot de passe trop court' }),
});
