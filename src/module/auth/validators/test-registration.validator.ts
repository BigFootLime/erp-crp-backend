import { z } from "zod";
import { canonicalizeAuthUsername } from "../domain/auth-identity";
import { strictEmail, strongPasswordReset } from "./_helpers";
import { workProfileFields, refineWorkProfile } from "./work-profile.validator";

export const AVATAR_KEYS = ["duck", "robot", "cat", "portrait-1", "portrait-2", "portrait-3", "programmer"] as const;
const name = z.string().trim().min(1, "Champ requis").max(80).transform(v => v.toLocaleUpperCase("fr-FR"));
export const testRegistrationSchema = z.object({
  username: z.string().trim().min(3).max(50).regex(/^[\p{L}\p{N}._-]+$/u, "Utilisez des lettres, chiffres, points, tirets ou underscores").transform(canonicalizeAuthUsername),
  name, surname: name, email: strictEmail, password: strongPasswordReset.refine(v => Buffer.byteLength(v, "utf8") <= 72, "Mot de passe trop long"),
  avatar_key: z.enum(AVATAR_KEYS),
  ...workProfileFields,
}).strict().superRefine(refineWorkProfile);
export type TestRegistration = z.infer<typeof testRegistrationSchema>;
