// Unités métrologiques (#229) — normalisation pure, sans I/O.
//
// L'éligibilité d'un instrument dépend de sa plage : comparer « 0–150 mm » à une
// cote exprimée en µm sans conversion produirait un refus (ou pire, une
// acceptation) absurde. On normalise donc vers une unité de base par dimension,
// et on refuse explicitement de comparer deux dimensions différentes.
//
// Le tableau est volontairement fermé : une unité inconnue n'est jamais
// « convertie au mieux », elle est signalée.

export type Dimension = "LENGTH" | "MASS" | "TEMPERATURE" | "PRESSURE" | "ANGLE" | "FORCE" | "TIME";

type UnitDefinition = {
  dimension: Dimension;
  /** Facteur vers l'unité de base de la dimension. */
  factor: number;
  /** Décalage appliqué APRÈS le facteur (températures). */
  offset?: number;
  canonical: string;
};

const BASE_UNITS: Record<Dimension, string> = {
  LENGTH: "mm",
  MASS: "g",
  TEMPERATURE: "°C",
  PRESSURE: "bar",
  ANGLE: "°",
  FORCE: "N",
  TIME: "s",
};

const UNITS: Record<string, UnitDefinition> = {
  // Longueur — base : millimètre.
  nm: { dimension: "LENGTH", factor: 1e-6, canonical: "nm" },
  um: { dimension: "LENGTH", factor: 1e-3, canonical: "µm" },
  µm: { dimension: "LENGTH", factor: 1e-3, canonical: "µm" },
  micron: { dimension: "LENGTH", factor: 1e-3, canonical: "µm" },
  microns: { dimension: "LENGTH", factor: 1e-3, canonical: "µm" },
  mm: { dimension: "LENGTH", factor: 1, canonical: "mm" },
  cm: { dimension: "LENGTH", factor: 10, canonical: "cm" },
  dm: { dimension: "LENGTH", factor: 100, canonical: "dm" },
  m: { dimension: "LENGTH", factor: 1000, canonical: "m" },
  in: { dimension: "LENGTH", factor: 25.4, canonical: "in" },
  inch: { dimension: "LENGTH", factor: 25.4, canonical: "in" },
  pouce: { dimension: "LENGTH", factor: 25.4, canonical: "in" },

  // Masse — base : gramme.
  mg: { dimension: "MASS", factor: 1e-3, canonical: "mg" },
  g: { dimension: "MASS", factor: 1, canonical: "g" },
  kg: { dimension: "MASS", factor: 1000, canonical: "kg" },
  t: { dimension: "MASS", factor: 1e6, canonical: "t" },

  // Température — base : degré Celsius (offset appliqué après facteur).
  "°c": { dimension: "TEMPERATURE", factor: 1, canonical: "°C" },
  c: { dimension: "TEMPERATURE", factor: 1, canonical: "°C" },
  celsius: { dimension: "TEMPERATURE", factor: 1, canonical: "°C" },
  k: { dimension: "TEMPERATURE", factor: 1, offset: -273.15, canonical: "K" },
  kelvin: { dimension: "TEMPERATURE", factor: 1, offset: -273.15, canonical: "K" },

  // Pression — base : bar.
  pa: { dimension: "PRESSURE", factor: 1e-5, canonical: "Pa" },
  kpa: { dimension: "PRESSURE", factor: 1e-2, canonical: "kPa" },
  mpa: { dimension: "PRESSURE", factor: 10, canonical: "MPa" },
  mbar: { dimension: "PRESSURE", factor: 1e-3, canonical: "mbar" },
  bar: { dimension: "PRESSURE", factor: 1, canonical: "bar" },
  psi: { dimension: "PRESSURE", factor: 0.0689476, canonical: "psi" },

  // Angle — base : degré.
  "°": { dimension: "ANGLE", factor: 1, canonical: "°" },
  deg: { dimension: "ANGLE", factor: 1, canonical: "°" },
  degre: { dimension: "ANGLE", factor: 1, canonical: "°" },
  rad: { dimension: "ANGLE", factor: 180 / Math.PI, canonical: "rad" },
  arcmin: { dimension: "ANGLE", factor: 1 / 60, canonical: "'" },
  "'": { dimension: "ANGLE", factor: 1 / 60, canonical: "'" },

  // Force — base : newton.
  n: { dimension: "FORCE", factor: 1, canonical: "N" },
  kn: { dimension: "FORCE", factor: 1000, canonical: "kN" },
  dan: { dimension: "FORCE", factor: 10, canonical: "daN" },

  // Temps — base : seconde.
  ms: { dimension: "TIME", factor: 1e-3, canonical: "ms" },
  s: { dimension: "TIME", factor: 1, canonical: "s" },
  min: { dimension: "TIME", factor: 60, canonical: "min" },
  h: { dimension: "TIME", factor: 3600, canonical: "h" },
};

function normalizeKey(unit: string): string {
  return unit
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/^degc$/, "°c")
    .replace(/^degre?s?$/, "deg");
}

export type ResolvedUnit = {
  input: string;
  canonical: string;
  dimension: Dimension;
  baseUnit: string;
};

export function resolveUnit(unit: string | null | undefined): ResolvedUnit | null {
  if (!unit) return null;
  const definition = UNITS[normalizeKey(unit)];
  if (!definition) return null;
  return {
    input: unit,
    canonical: definition.canonical,
    dimension: definition.dimension,
    baseUnit: BASE_UNITS[definition.dimension],
  };
}

export function isKnownUnit(unit: string | null | undefined): boolean {
  return resolveUnit(unit) !== null;
}

/** Convertit une valeur vers l'unité de base de sa dimension. */
export function toBaseValue(value: number, unit: string): number | null {
  const definition = UNITS[normalizeKey(unit)];
  if (!definition || !Number.isFinite(value)) return null;
  return value * definition.factor + (definition.offset ?? 0);
}

export type UnitConversion =
  | { ok: true; value: number }
  | { ok: false; reason: "UNKNOWN_SOURCE" | "UNKNOWN_TARGET" | "DIMENSION_MISMATCH" };

/** Convertit une valeur d'une unité vers une autre de la MÊME dimension. */
export function convertValue(value: number, from: string, to: string): UnitConversion {
  const source = UNITS[normalizeKey(from)];
  if (!source) return { ok: false, reason: "UNKNOWN_SOURCE" };
  const target = UNITS[normalizeKey(to)];
  if (!target) return { ok: false, reason: "UNKNOWN_TARGET" };
  if (source.dimension !== target.dimension) return { ok: false, reason: "DIMENSION_MISMATCH" };

  const base = value * source.factor + (source.offset ?? 0);
  return { ok: true, value: (base - (target.offset ?? 0)) / target.factor };
}

export function sameDimension(left: string | null | undefined, right: string | null | undefined): boolean {
  const a = resolveUnit(left);
  const b = resolveUnit(right);
  if (!a || !b) return false;
  return a.dimension === b.dimension;
}

/** Liste des unités acceptées, pour alimenter les listes déroulantes serveur. */
export function listSupportedUnits(): Array<{ canonical: string; dimension: Dimension }> {
  const seen = new Map<string, Dimension>();
  for (const definition of Object.values(UNITS)) {
    if (!seen.has(definition.canonical)) seen.set(definition.canonical, definition.dimension);
  }
  return Array.from(seen.entries())
    .map(([canonical, dimension]) => ({ canonical, dimension }))
    .sort((left, right) =>
      left.dimension === right.dimension
        ? left.canonical.localeCompare(right.canonical)
        : left.dimension.localeCompare(right.dimension)
    );
}
