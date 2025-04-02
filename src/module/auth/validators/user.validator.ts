import { z } from 'zod';

// Rôles autorisés
const roles = [
  'Directeur',
  'Employee',
  'Administrateur Systeme et Reseau',
  'Responsable Qualité',
  'Secretaire',
  'Responsable Programmation'
] as const;

const genders = ['Male', 'Female'] as const;

const statuses = ['Active', 'Inactive', 'Suspended'] as const;

export const registerSchema = z.object({
  username: z.string().min(3),
  password: z.string().min(6),
  name: z.string(),
  surname: z.string(),
  email: z.string().email(),

  // ✅ Téléphone au format français (+33 suivi de 9 chiffres)
  tel_no: z.string().regex(/^\+33[1-9][0-9]{8}$/, {
    message: "Le numéro doit être au format +33XXXXXXXXX",
  }),

  gender: z.enum(genders, {
    errorMap: () => ({ message: "Le genre doit être 'Male' ou 'Female'" })
  }),

  address: z.string(),
  lane: z.string(),
  house_no: z.string(),

  postcode: z.string().regex(/^\d{5}$/, {
    message: "Le code postal doit contenir 5 chiffres"
  }),

  country: z.literal('France', {
    errorMap: () => ({ message: "Le pays doit être 'France'" })
  }),

  salary: z.number().min(0, {
    message: "Le salaire doit être un nombre positif"
  }),

  date_of_birth: z.string(), // format YYYY-MM-DD

  // ✅ Role strictement contrôlé
  role: z.enum(roles, {
    errorMap: () => ({
      message: "Le rôle n'est pas autorisé"
    })
  }),

  social_security_number: z.string().length(15, {
    message: "Le numéro de sécurité sociale doit contenir 15 chiffres"
  }),

  // ✅ Statut optionnel mais vérifié si présent
  status: z.enum(statuses).optional(),

  // Dates optionnelles mais validables ensuite
  employment_date: z.string().optional(),
  employment_end_date: z.string().optional()
});
