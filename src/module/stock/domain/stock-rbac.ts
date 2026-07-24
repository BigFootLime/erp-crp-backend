export type StockCapability =
  | "read"
  | "referential_manage"
  | "movement_create"
  | "movement_post"
  | "movement_cancel"
  | "movement_compensate"
  | "negative_stock_override"
  | "reservation_manage"
  | "lot_quality"
  | "inventory_create"
  | "inventory_count"
  | "inventory_approve"
  | "inventory_close"
  | "documents_manage"
  | "costs_read"
  | "export";

const ADMIN_OR_DIRECTOR = ["admin", "administrateur", "directeur"] as const;
const STOCK_OPERATIONS = [
  ...ADMIN_OR_DIRECTOR,
  "stock",
  "logisti",
  "magasin",
  "production",
  "atelier",
  "program",
  "planif",
] as const;
const READERS = [
  ...STOCK_OPERATIONS,
  "qualit",
  "audit",
  "method",
  "achat",
  "appro",
  "secr",
  "secret",
  "employee",
  "employe",
] as const;

const NEEDLES: Record<StockCapability, readonly string[]> = {
  read: READERS,
  referential_manage: [...ADMIN_OR_DIRECTOR, "stock", "logisti", "magasin", "program", "method", "achat", "appro"],
  movement_create: STOCK_OPERATIONS,
  movement_post: [...ADMIN_OR_DIRECTOR, "stock", "logisti", "magasin", "production", "program"],
  movement_cancel: [...ADMIN_OR_DIRECTOR, "stock", "logisti", "magasin", "program"],
  movement_compensate: [...ADMIN_OR_DIRECTOR, "stock", "logisti"],
  negative_stock_override: ADMIN_OR_DIRECTOR,
  reservation_manage: [...ADMIN_OR_DIRECTOR, "stock", "logisti", "magasin", "planif", "program"],
  lot_quality: [...ADMIN_OR_DIRECTOR, "qualit"],
  inventory_create: [...ADMIN_OR_DIRECTOR, "stock", "logisti", "magasin"],
  inventory_count: [...ADMIN_OR_DIRECTOR, "stock", "logisti", "magasin", "employee", "employe"],
  inventory_approve: [...ADMIN_OR_DIRECTOR, "stock", "logisti", "qualit"],
  inventory_close: [...ADMIN_OR_DIRECTOR, "stock", "logisti"],
  documents_manage: [...ADMIN_OR_DIRECTOR, "stock", "logisti", "magasin", "qualit", "achat", "appro"],
  costs_read: [...ADMIN_OR_DIRECTOR, "compt", "achat", "appro", "secr", "secret"],
  export: [...ADMIN_OR_DIRECTOR, "stock", "logisti", "qualit", "audit", "compt"],
};

export function roleHasStockCapability(
  role: string | null | undefined,
  capability: StockCapability
): boolean {
  const normalized = (role ?? "").trim().toLowerCase();
  if (!normalized) return false;
  return NEEDLES[capability].some((needle) => normalized.includes(needle));
}
