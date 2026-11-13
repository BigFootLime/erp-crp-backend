import { z } from "zod";
import { HttpError } from "../../../utils/httpError";

export const nuanceNormes = ["FR", "EN", "WERKSTOFF", "USA"] as const;
export const nuanceNormeFields = ["norme_fr", "norme_en", "norme_werkstoff", "norme_usa"] as const;
export type NuanceNorme = typeof nuanceNormes[number];
export type NuanceIdentity = Record<typeof nuanceNormeFields[number], string | null> & {
  designation_principale: NuanceNorme | "LEGACY";
  libelle: string;
};
const designation = z.string().trim().max(40).refine(value => !value || /[a-z0-9]/i.test(value), "Une désignation doit contenir une lettre ou un chiffre").nullable().optional();
export const nuanceNormeShape = {
  norme_fr: designation,
  norme_en: designation,
  norme_werkstoff: designation,
  norme_usa: designation,
  designation_principale: z.enum([...nuanceNormes, "LEGACY"]).optional(),
};

/** No standard is inferred from an old workshop code. */
export function nuanceIdentity(source: Record<string, unknown>): NuanceIdentity {
  const fields = Object.fromEntries(nuanceNormeFields.map(key => [key, typeof source[key] === "string" ? source[key].trim() || null : null])) as Pick<NuanceIdentity, typeof nuanceNormeFields[number]>;
  const primary = source.designation_principale as NuanceIdentity["designation_principale"] | undefined;
  const index = nuanceNormes.indexOf(primary as NuanceNorme);
  return { ...fields, designation_principale: index < 0 ? "LEGACY" : primary!, libelle: index < 0 ? String(source.code ?? "") : fields[nuanceNormeFields[index]] ?? String(source.code ?? "") };
}

export function resolveNuanceIdentity(patch: Record<string, unknown>, previous?: Record<string, unknown>): NuanceIdentity {
  const merged = { ...previous, ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) };
  const identity = nuanceIdentity(merged);
  const first = nuanceNormeFields.findIndex(key => Boolean(identity[key]));
  const changesIdentity = nuanceNormeFields.some(key => patch[key] !== undefined) || patch.designation_principale !== undefined;
  if (first < 0) {
    if (previous && !changesIdentity && identity.designation_principale === "LEGACY") return identity;
    throw new HttpError(400, "NUANCE_STANDARD_REQUIRED", "Renseignez au moins une désignation : française, européenne, DIN / Werkstoff ou USA.");
  }
  // A legacy entry becomes classified only after the user supplies its designations.
  const primary = patch.designation_principale ?? (identity.designation_principale === "LEGACY" ? nuanceNormes[first] : identity.designation_principale);
  const index = nuanceNormes.indexOf(primary as NuanceNorme);
  if (index < 0 || !identity[nuanceNormeFields[index]]) throw new HttpError(400, "NUANCE_PRIMARY_REQUIRED", "Choisissez une désignation principale parmi les normes renseignées.");
  return { ...identity, designation_principale: primary as NuanceNorme, libelle: identity[nuanceNormeFields[index]]! };
}
