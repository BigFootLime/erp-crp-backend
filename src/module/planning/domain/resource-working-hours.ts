import { z } from "zod";
import { WORKSTATION_TYPES } from "../../production/domain/workstation-defaults";

export const RESOURCE_WORKING_HOURS_KEY = "planning.resource_working_hours";
export const STANDARD_POSTE_HOURS_TYPES = ["DECOUPE", "CONTROLE", "ASSEMBLAGE"] as const;

const workingTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Saisissez une heure au format HH:MM.");
const workingWindow = z.object({ start: workingTime, end: workingTime }).strict()
  .refine(({ start, end }) => start < end, {
    path: ["end"], message: "L’heure de fin doit être postérieure à l’heure de début.",
  });

export const resourceWorkingHoursSchema = z.object({
  machines: workingWindow.optional(),
  postes: z.object({
    categories: z.array(z.enum(WORKSTATION_TYPES)).min(1),
    hours: workingWindow,
  }).strict().optional(),
}).strict();

export const updatePosteHoursSchema = z.object({
  expected_updated_at: z.string().nullable(),
  hours: workingWindow,
}).strict();
export type UpdatePosteHours = z.infer<typeof updatePosteHoursSchema>;
