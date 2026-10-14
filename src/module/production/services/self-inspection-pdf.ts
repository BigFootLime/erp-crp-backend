import { renderSelfInspectionWorkshop, type SelfInspectionIdentity } from "./self-inspection-workshop";

export type SelfInspectionSnapshot = {
  of: { id: number; numero: string; quantite_lancee: number };
  version: { indice: string };
  plan: { code: string; version: number; label: string };
  characteristics: Array<Record<string, unknown>>;
  source_hash: string;
  identity?: SelfInspectionIdentity;
  generated_at?: string;
  layout_version?: "self-inspection/2.0";
};

/** A blank inspection form, never an inspection result or a conformity certificate. */
export async function renderSelfInspectionPdf(
  snapshot: SelfInspectionSnapshot,
): Promise<Buffer> {
  return renderSelfInspectionWorkshop(snapshot);
}
