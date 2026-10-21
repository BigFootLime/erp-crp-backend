import { z } from "zod";
import { planningClientPastel } from "../domain/planning-client-color";

export const planningClientColorSchema = z.object({
  params: z.object({ clientId: z.string().trim().min(1).max(160) }).strict(),
  body: z.object({ color: z.string().trim().refine(value => planningClientPastel(value) !== null,
    "Choisissez une couleur valide ; le rouge est réservé aux problèmes.").transform(value => planningClientPastel(value)!).nullable() }).strict(),
}).strict();
