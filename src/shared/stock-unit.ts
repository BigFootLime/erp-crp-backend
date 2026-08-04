/**
 * Canonical stock-unit vocabulary observed in CERP's historical article,
 * import, surface-finish and production contracts.
 *
 * This adapter only normalises spelling and case. It never converts a
 * quantity between units.
 */
const STOCK_UNIT_ALIASES: Readonly<Record<string, string>> = {
  pc: "u",
  pce: "u",
  pces: "u",
  pcs: "u",
  piece: "u",
  pieces: "u",
  pièce: "u",
  pièces: "u",
  unit: "u",
  units: "u",
  unite: "u",
  unites: "u",
  unité: "u",
  unités: "u",
};

export function canonicalizeStockUnitCode(unitCode: string | null | undefined): string | null {
  const token = unitCode?.trim().normalize("NFKC").toLocaleLowerCase("fr-FR") ?? "";
  if (!token) return null;
  return STOCK_UNIT_ALIASES[token] ?? token;
}
