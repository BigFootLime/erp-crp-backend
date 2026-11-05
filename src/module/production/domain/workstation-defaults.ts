import { z } from "zod";

export const WORKSTATION_TYPES = ["DECOUPE", "CONTROLE", "EMBALLAGE", "LAVAGE", "ASSEMBLAGE", "AUTRE"] as const;
export type WorkstationType = typeof WORKSTATION_TYPES[number];
export const WORKSTATION_LABELS: Record<WorkstationType, string> = {
  DECOUPE: "Découpe", CONTROLE: "Contrôle", EMBALLAGE: "Emballage", LAVAGE: "Lavage", ASSEMBLAGE: "Montage", AUTRE: "Autre opération manuelle",
};
export const WORKSTATION_SETTING = "production.workstation_defaults";
export const workstationDefaultsSchema = z.object({
  postes: z.object(Object.fromEntries(WORKSTATION_TYPES.map(type => [type, z.string().uuid().nullable().optional()])) as Record<WorkstationType, z.ZodOptional<z.ZodNullable<z.ZodString>>>).strict(),
  programmer_user_ids: z.array(z.number().int().positive()).max(200).refine(ids => new Set(ids).size === ids.length, "Un programmeur ne doit apparaître qu’une fois."),
}).strict();
export type WorkstationDefaults = z.infer<typeof workstationDefaultsSchema>;
export type Workstation = { id: string; code: string; label: string; machine_id: string | null; is_active: boolean; archived_at: string | null };

export function isWorkstationType(type: string | null | undefined): type is WorkstationType {
  return WORKSTATION_TYPES.includes(type as WorkstationType);
}

/** Explicit settings win. Canonical codes retain compatibility with existing ERP setups. */
export function resolveDefaultPoste(type: WorkstationType, defaults: WorkstationDefaults, postes: readonly Workstation[]) {
  const selected = defaults.postes[type];
  if (selected !== undefined) return postes.find(poste => poste.id === selected && poste.is_active && !poste.archived_at && !poste.machine_id) ?? null;
  const candidates = postes.filter(poste => poste.code.trim().toUpperCase() === type && poste.is_active && !poste.archived_at && !poste.machine_id);
  return candidates.length === 1 ? candidates[0] : null;
}
