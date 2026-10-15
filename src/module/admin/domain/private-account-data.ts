import { z } from "zod";
import { HttpError } from "../../../utils/httpError";
import { isoDate } from "../../auth/validators/_helpers";

export const PRIVATE_ACCOUNT_FIELDS = ["salary", "date_of_birth", "national_id", "social_security_number"] as const;
/** Old account forms sent empty HR fields. Ignore empty legacy values, never clear private data. */
export function ordinaryAccountInput(body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const input = { ...(body as Record<string, unknown>) };
  for (const field of PRIVATE_ACCOUNT_FIELDS) {
    if (!(field in input)) continue;
    if (input[field] !== null && input[field] !== undefined && input[field] !== "") {
      throw new HttpError(422, "PRIVATE_PROFILE_SEPARATE", "Les données RH privées se modifient dans le périmètre RH habilité.");
    }
    delete input[field];
  }
  return input;
}
export const privateAccountPatchSchema = z.object({
  salary: z.number().finite().min(0).max(1_000_000).nullable().optional(),
  date_of_birth: isoDate("Date de naissance").refine(value => new Date(value) <= new Date(), "Date future interdite").nullable().optional(),
  national_id: z.string().trim().min(1).max(200).nullable().optional(),
  social_security_number: z.string().trim().regex(/^\d{15}$/).nullable().optional(),
}).strict().refine(value => Object.keys(value).length > 0, "Aucune modification demandée");
