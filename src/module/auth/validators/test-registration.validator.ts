import { z } from "zod";
import { canonicalizeAuthUsername } from "../domain/auth-identity";
import { strictEmail, strongPasswordReset } from "./_helpers";

export const AVATAR_KEYS = ["duck", "robot", "cat", "portrait-1", "portrait-2", "portrait-3", "programmer"] as const;
const name = z.string().trim().min(1, "Champ requis").max(80).transform(v => v.toLocaleUpperCase("fr-FR"));
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Heure invalide");
const hours = z.number().positive("Durée requise").refine(v => Number.isInteger(Math.round(v * 10000) / 100), "Deux décimales maximum");
export const testRegistrationSchema = z.object({
  username: z.string().trim().min(3).max(50).regex(/^[\p{L}\p{N}._-]+$/u, "Utilisez des lettres, chiffres, points, tirets ou underscores").transform(canonicalizeAuthUsername),
  name, surname: name, email: strictEmail, password: strongPasswordReset.refine(v => Buffer.byteLength(v, "utf8") <= 72, "Mot de passe trop long"),
  avatar_key: z.enum(AVATAR_KEYS),
  weekly_hours_target: hours.refine(v => v <= 168, "168 heures maximum"),
  daily_hours_target: hours.refine(v => v <= 24, "24 heures maximum"),
  day_start: time, day_end: time,
  break_minutes: z.number().int().min(0).max(240),
  working_days: z.array(z.number().int().min(1).max(7)).min(1).max(7).refine(v => new Set(v).size === v.length, "Jour en double"),
}).strict().superRefine((v, ctx) => {
  const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
  if (minutes(v.day_end) - minutes(v.day_start) <= v.break_minutes) ctx.addIssue({ code: "custom", path: ["day_end"], message: "La fin doit suivre le début et laisser du temps travaillé après la pause" });
  if (v.daily_hours_target > v.weekly_hours_target || v.weekly_hours_target > v.daily_hours_target * 7) ctx.addIssue({ code: "custom", path: ["weekly_hours_target"], message: "Vérifiez les durées quotidienne et hebdomadaire" });
});
export type TestRegistration = z.infer<typeof testRegistrationSchema>;
