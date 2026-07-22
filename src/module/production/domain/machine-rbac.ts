export type MachineCapability =
  | "read"
  | "create"
  | "update"
  | "archive"
  | "restore"
  | "model_update"
  | "availability"
  | "maintenance"
  | "documents"
  | "costs";

const NEEDLES: Record<MachineCapability, readonly string[]> = {
  read: ["admin", "administrateur", "directeur", "production", "atelier", "maintenance", "program", "planif", "qualit", "outillage", "secr", "secret", "method"],
  create: ["admin", "administrateur", "directeur", "production", "atelier", "maintenance", "program", "method"],
  update: ["admin", "administrateur", "directeur", "production", "atelier", "maintenance", "program", "method"],
  archive: ["admin", "administrateur", "directeur"],
  restore: ["admin", "administrateur", "directeur"],
  model_update: ["admin", "administrateur", "directeur", "program", "method"],
  availability: ["admin", "administrateur", "directeur", "production", "atelier", "maintenance", "program", "planif"],
  maintenance: ["admin", "administrateur", "directeur", "maintenance", "production", "atelier"],
  documents: ["admin", "administrateur", "directeur", "maintenance", "program", "method", "qualit"],
  costs: ["admin", "administrateur", "directeur", "compt", "program"],
};

export function roleHasMachineCapability(role: string | null | undefined, capability: MachineCapability): boolean {
  const normalized = (role ?? "").trim().toLowerCase();
  if (!normalized) return false;
  return NEEDLES[capability].some((needle) => normalized.includes(needle));
}
