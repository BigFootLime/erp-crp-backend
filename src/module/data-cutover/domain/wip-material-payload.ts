import { z } from "zod";
import { HttpError } from "../../../utils/httpError";
import type { WipMaterialOpeningInput } from "../../production/wip-material-opening/wip-material-opening.types";

const reference = z.string().trim().max(500).refine((value) => !/[<>\u0000-\u001f]/.test(value), "Référence attendue sans balise ni caractère de contrôle.");
const optionalReference = reference.nullish();
const identifier = z.string().guid();
const MAX_WIP_MATERIAL_QUANTITY = 9_999_999_999.9999;
const fourDecimalQuantity = z.number().finite().nonnegative().max(MAX_WIP_MATERIAL_QUANTITY).refine((quantity) => {
  const rounded = Number(quantity.toFixed(4));
  return Math.abs(quantity - rounded) <= Math.max(1e-9, Math.abs(quantity) * Number.EPSILON * 4);
}, "Quatre décimales maximum sans arrondi automatique.");
export const wipMaterialPayloadSchema = z.object({
  materialState: z.enum(["NONE_CONSUMED", "PARTIAL", "ALL_ALREADY_CONSUMED"]),
  requirements: z.array(z.object({
    technicalPurchaseId: identifier,
    articleId: identifier,
    unit: z.string().trim().min(1).max(30),
    quantityConsumed: fourDecimalQuantity,
    physicalLotId: identifier.nullish(),
    historicalTraceReference: optionalReference,
    evidenceReference: reference.refine((value) => value.length > 0, "Le justificatif de la quantité consommée est requis."),
    ownerClientId: z.string().trim().min(1).max(120).regex(/^[^<>\u0000-\u001f]+$/).nullish(),
    qualityStatus: z.enum(["", "LIBERE", "QUARANTAINE", "BLOQUE"]).nullish(),
    qualityEvidenceReference: optionalReference,
    certificateReference: optionalReference,
    heatReference: optionalReference,
    materialCategory: optionalReference,
  }).strict()).max(64),
}).strict().superRefine((value, context) => {
  const unique = new Set<string>();
  value.requirements.forEach((line, index) => {
    if (unique.has(line.technicalPurchaseId)) context.addIssue({ code: "custom", path: ["requirements", index], message: "Une exigence matière ne doit apparaître qu'une fois." });
    unique.add(line.technicalPurchaseId);
    if (line.quantityConsumed <= 0) return;
    if (value.materialState === "NONE_CONSUMED") context.addIssue({ code: "custom", path: ["materialState"], message: "La consommation déclarée contredit l'absence de matière utilisée." });
    if (line.qualityStatus !== "LIBERE") context.addIssue({ code: "custom", path: ["requirements", index, "qualityStatus"], message: "La matière consommée doit avoir été libérée avec un justificatif." });
    if (!line.physicalLotId) for (const field of ["historicalTraceReference", "qualityEvidenceReference", "certificateReference", "heatReference", "materialCategory"] as const) {
      if (!line[field]?.trim()) context.addIssue({ code: "custom", path: ["requirements", index, field], message: "Compléter le lot historique, sa matière et les références qualité et certificat." });
    }
  });
});

export function parseWipMaterialPayload(value: unknown): Pick<WipMaterialOpeningInput, "materialState" | "requirements"> {
  if (typeof value !== "string" || !value || value.length > 8000) throw new HttpError(422, "CUTOVER_WIP_MATERIAL_INVALID", "Compléter le tableau matière de la cohorte ; sa taille est limitée à 8 000 caractères.");
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new HttpError(422, "CUTOVER_WIP_MATERIAL_INVALID", "Le tableau matière doit être préparé depuis les champs proposés."); }
  const result = wipMaterialPayloadSchema.safeParse(parsed);
  if (!result.success) {
    const first = result.error.issues[0];
    const line = typeof first.path[1] === "number" ? `Matière ${first.path[1] + 1} : ` : "";
    throw new HttpError(422, "CUTOVER_WIP_MATERIAL_INVALID", `${line}${first.message}`, { field: "materialOpening" });
  }
  return result.data;
}
