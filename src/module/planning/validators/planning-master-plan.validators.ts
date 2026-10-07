import { z } from 'zod';

const civilDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(+parsed) && parsed.toISOString().slice(0, 10) === value;
}, { message: 'Date de début invalide.' });

export const masterPlanQuerySchema = z.object({
  start: civilDate,
  weeks: z.coerce.number().int().refine(value => [4, 13, 26, 52].includes(value)).default(13),
  revision: z.string().regex(/^\d+$/).optional(),
}).strict();
export type MasterPlanQuery = z.infer<typeof masterPlanQuerySchema>;
