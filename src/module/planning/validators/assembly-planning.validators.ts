import { z } from "zod";

export const weekSchema = z.iso.date().refine((date) => new Date(date + "T00:00:00Z").getUTCDay() === 1, "Indiquez le lundi de la semaine.");
const userId = z.number().int().positive();
export const members = z.array(userId.nullable()).length(3).refine(
  (ids) => ids.filter((id) => id !== null).length === new Set(ids.filter((id) => id !== null)).size,
  "Chaque membre de l’équipe doit être différent.",
);
const minutes = z.array(z.number().int().min(0).max(1440).nullable()).length(7);
export const presenceSchema = z.array(z.object({ userId, minutes })).max(3);
export const saveSchema = z.object({ week: weekSchema, team: members, presence: presenceSchema,
  teamVersion: z.string().nullable(), weekVersion: z.string().nullable() });
export type SaveAssemblyWeek = z.infer<typeof saveSchema>;
