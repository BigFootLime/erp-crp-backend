export type MarginCapability = "read_costs" | "manage_rates" | "manage_inputs" | "snapshot" | "export";

const CAPABILITY_ROLE_NEEDLES: Record<MarginCapability, readonly string[]> = {
  read_costs: ["admin", "administrateur", "direction", "directeur", "compt", "controle", "contrôle", "method", "méthod"],
  manage_rates: ["admin", "administrateur", "direction", "directeur", "compt", "controle", "contrôle"],
  manage_inputs: ["admin", "administrateur", "direction", "directeur", "compt", "controle", "contrôle", "method", "méthod"],
  snapshot: ["admin", "administrateur", "direction", "directeur", "compt", "controle", "contrôle"],
  export: ["admin", "administrateur", "direction", "directeur", "compt", "controle", "contrôle"],
};

/** Deny-by-default server policy. Account-module grants are handled by the route middleware. */
export function roleHasMarginCapability(role: string | null | undefined, capability: MarginCapability): boolean {
  const normalized = role?.trim().toLocaleLowerCase("fr") ?? "";
  return normalized.length > 0 && CAPABILITY_ROLE_NEEDLES[capability].some((needle) => normalized.includes(needle));
}

/**
 * L'accès au module reporting est seulement un filtre de navigation/lecture.
 * Il ne confère jamais une capacité financière d'écriture, de preuve ou d'export.
 */
export function canUseMarginCapability(
  role: string | null | undefined,
  capability: MarginCapability,
  hasReportingModuleAccess: boolean,
): boolean {
  if (roleHasMarginCapability(role, capability)) return true;
  return capability === "read_costs" && hasReportingModuleAccess;
}
