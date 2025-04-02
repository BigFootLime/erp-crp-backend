import { Request, Response } from 'express';
import { registerSchema } from '../validators/user.validator';
import { registerUser } from '../services/auth.service';
import { loginSchema } from '../validators/auth.validator';
import { loginUser } from '../services/auth.service';
import {asyncHandler} from '../../../utils/asyncHandler';

export const register = asyncHandler(async (req: Request, res: Response) => {
  const validated = registerSchema.parse(req.body);
  if (
    validated.employment_end_date &&
    validated.employment_date &&
    new Date(validated.employment_end_date) <= new Date(validated.employment_date)
  ) {
    return res.status(400).json({
      error: "La date de fin d’emploi doit être postérieure à la date d’embauche"
    });
  }
  const user = await registerUser(validated);

  return res.status(201).json({
    message: 'Utilisateur créé avec succès',
    user,
  });
});

// 📌 Connexion utilisateur
export const login = asyncHandler(async (req: Request, res: Response) => {
    const { email, password } = loginSchema.parse(req.body);
    const data = await loginUser(email, password);
  
    return res.status(200).json({
      message: "Connexion réussie",
      ...data
    });
  });
