import { HttpError } from "../../../utils/httpError";

export type WorkshopFrozenPlan = { id: string; version_id: string; sha256: string; role: "PLAN_CLIENT" | "PLAN_FABRICATION";
  source_role?: "PLAN" | "TECHNICAL_DRAWING" | "MANUFACTURING_DRAWING" };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const sha = /^[a-f0-9]{64}$/;

/** Frozen OF references only. A missing version/hash is an action to repair,
 * never permission to silently substitute the latest PT document. */
export function workshopFrozenPlans(snapshot: unknown): WorkshopFrozenPlan[] {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return [];
  const documents = (snapshot as Record<string, unknown>).documents;
  if (!Array.isArray(documents)) return [];
  if (documents.length > 200) throw new HttpError(422, "WORKSHOP_PACK_LIMIT", "Vérifiez les documents du dossier technique.");
  const plans: WorkshopFrozenPlan[] = [], seen = new Set<string>();
  for (const value of documents) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const document = value as Record<string, unknown>;
    const role = ["PLAN_CLIENT", "PLAN", "TECHNICAL_DRAWING"].includes(String(document.role)) ? "PLAN_CLIENT"
      : ["PLAN_FABRICATION", "MANUFACTURING_DRAWING"].includes(String(document.role)) ? "PLAN_FABRICATION" : null;
    if (!role) continue;
    if (typeof document.id !== "string" || !uuid.test(document.id) || typeof document.version_id !== "string" || !uuid.test(document.version_id)
      || typeof document.sha256 !== "string" || !sha.test(document.sha256)) {
      throw new HttpError(409, "WORKSHOP_PLAN_UNQUALIFIED", "Rattachez une édition vérifiée du plan à cet OF.");
    }
    const key = `${role}:${document.id}:${document.version_id}`;
    if (seen.has(key)) continue;
    seen.add(key); plans.push({ id: document.id, version_id: document.version_id, sha256: document.sha256, role,
      ...(document.role === role ? {} : { source_role: document.role as WorkshopFrozenPlan["source_role"] }) });
  }
  return plans.sort((a, b) => (a.role === b.role ? a.version_id.localeCompare(b.version_id) : a.role === "PLAN_CLIENT" ? -1 : 1));
}
