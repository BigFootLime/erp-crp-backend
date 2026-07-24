export type LivraisonCapability =
  | "read"
  | "prepare"
  | "allocate"
  | "ship"
  | "deliver"
  | "cancel"
  | "documents_manage"
  | "proof_manage"
  | "export"

const ADMIN_OR_DIRECTOR = ["admin", "administrateur", "directeur"] as const
const LOGISTICS = [...ADMIN_OR_DIRECTOR, "stock", "logisti", "magasin"] as const
const PREPARERS = [...LOGISTICS, "production", "atelier", "program", "planif", "secr", "secret"] as const
const READERS = [...PREPARERS, "qualit", "audit", "commercial", "compt", "employee", "employe"] as const

const NEEDLES: Record<LivraisonCapability, readonly string[]> = {
  read: READERS,
  prepare: PREPARERS,
  allocate: [...LOGISTICS, "planif", "program"],
  ship: LOGISTICS,
  deliver: LOGISTICS,
  cancel: [...ADMIN_OR_DIRECTOR, "logisti", "stock"],
  documents_manage: [...LOGISTICS, "qualit", "secr", "secret"],
  proof_manage: [...LOGISTICS, "commercial", "secr", "secret"],
  export: [...ADMIN_OR_DIRECTOR, "logisti", "stock", "qualit", "audit", "commercial"],
}

export function roleHasLivraisonCapability(
  role: string | null | undefined,
  capability: LivraisonCapability
): boolean {
  const normalized = (role ?? "").trim().toLowerCase()
  if (!normalized) return false
  return NEEDLES[capability].some((needle) => normalized.includes(needle))
}
