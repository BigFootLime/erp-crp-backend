import {
  isSpecialMaterialProfile,
  normalizeMaterialProfile,
  type MaterialProfileCode,
} from "../../../shared/codes/material-article-code";

/**
 * Read-only representation used by Base OLD.
 *
 * Legacy Clipper articles keep their immutable ART-* code. This helper only
 * derives the workshop definition displayed for historical stock.
 */
export type OldMaterialDefinitionSource = {
  article_category: string | null;
  designation: string;
  profile_code: string | null;
  nuance_code: string | null;
  etat_code: string | null;
  sous_etat_code: string | null;
  longueur_mm: number | null;
  largeur_mm: number | null;
  hauteur_mm: number | null;
  epaisseur_mm: number | null;
  diametre_mm: number | null;
};

type ParsedLegacyDefinition = {
  nuance: string | null;
  etat: string | null;
  dimensions: string[];
};

function normalizeSegment(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  return normalized || null;
}

function dimensionToken(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(String(value).replace(",", "."));
  return Number.isFinite(numeric) && numeric > 0 ? String(numeric) : null;
}

function parseIdentity(prefix: string): Pick<ParsedLegacyDefinition, "nuance" | "etat"> {
  const slashIndex = prefix.lastIndexOf("/");
  if (slashIndex < 0) return { nuance: null, etat: null };

  const beforeSlash = prefix.slice(0, slashIndex).trim();
  const afterSlash = prefix.slice(slashIndex + 1).trim();
  const nuanceMatch = beforeSlash.match(/([A-Z0-9]+(?:[.-][A-Z0-9]+)*)\s*$/i);

  return {
    nuance: normalizeSegment(nuanceMatch?.[1] ?? null),
    etat: normalizeSegment(afterSlash.replace(/^[-\s]+/, "")),
  };
}

function parseLegacyDesignation(
  profile: MaterialProfileCode,
  designation: string
): ParsedLegacyDefinition | null {
  const normalized = designation.replace(/\u00a0/g, " ").trim();
  let match: RegExpMatchArray | null = null;
  let dimensions: string[] = [];

  if (profile === "PL") {
    match = normalized.match(
      /(\d+(?:[.,]\d+)?)\s*(?:X|×)\s*(\d+(?:[.,]\d+)?)\s*(?:EP|EPAISSEUR)\s*=?\s*(\d+(?:[.,]\d+)?)/i
    );
    if (match) dimensions = [match[1], match[2], match[3]];
  } else if (profile === "TUBE") {
    match = normalized.match(
      /(?:Ø|⌀|DIAM(?:ETRE)?\.?)\s*(\d+(?:[.,]\d+)?)\s*(?:EP|EPAISSEUR)\s*=?\s*(\d+(?:[.,]\d+)?)\s*(?:L|LG|X)\s*(\d+(?:[.,]\d+)?)/i
    );
    if (match) dimensions = [match[3], match[1], match[2]];
  } else if (profile === "RO") {
    match = normalized.match(
      /(?:Ø|⌀|DIAM(?:ETRE)?\.?)\s*(\d+(?:[.,]\d+)?)\s*(?:L|LG|X)\s*(\d+(?:[.,]\d+)?)/i
    );
    if (match) dimensions = [match[2], match[1]];
  } else if (profile === "U") {
    match = normalized.match(
      /LARG(?:EUR)?\s*(\d+(?:[.,]\d+)?)\s*(?:HT|HAUT(?:EUR)?)\s*(\d+(?:[.,]\d+)?)\s*(?:EP|EPAISSEUR)\s*(\d+(?:[.,]\d+)?)(?:\s*(?:L|LG)\s*(\d+(?:[.,]\d+)?))?/i
    );
    if (match) dimensions = [match[4], match[1], match[2], match[3]];
  }

  if (!match || match.index === undefined) return null;
  const identity = parseIdentity(normalized.slice(0, match.index));
  const normalizedDimensions = dimensions
    .map(dimensionToken)
    .filter((value): value is string => Boolean(value));

  return { ...identity, dimensions: normalizedDimensions };
}

function structuredDimensions(source: OldMaterialDefinitionSource, profile: MaterialProfileCode): string[] {
  const length = dimensionToken(source.longueur_mm);
  const width = dimensionToken(source.largeur_mm);
  const height = dimensionToken(source.hauteur_mm);
  const thickness = dimensionToken(source.epaisseur_mm);
  const diameter = dimensionToken(source.diametre_mm);

  if (profile === "PL") return [length, width, thickness].filter((value): value is string => Boolean(value));
  if (profile === "RO") return [length, diameter].filter((value): value is string => Boolean(value));
  if (profile === "TUBE") return [length, diameter, thickness].filter((value): value is string => Boolean(value));
  if (profile === "U") return [length, width, height, thickness].filter((value): value is string => Boolean(value));
  return [];
}

export function buildOldMaterialDefinition(source: OldMaterialDefinitionSource): string | null {
  if (source.article_category !== "matiere") return null;

  let profile: MaterialProfileCode;
  try {
    profile = normalizeMaterialProfile(source.profile_code);
  } catch {
    return null;
  }
  if (isSpecialMaterialProfile(profile)) return null;

  const legacy = parseLegacyDesignation(profile, source.designation);
  const nuance = normalizeSegment(source.nuance_code) ?? legacy?.nuance ?? null;
  const etat = normalizeSegment(source.etat_code) ?? legacy?.etat ?? null;
  const sousEtat = normalizeSegment(source.sous_etat_code);
  const structured = structuredDimensions(source, profile);
  const dimensions = structured.length > 0 ? structured : legacy?.dimensions ?? [];

  // A partial reconstruction would look authoritative while shifting segments.
  // Keep the immutable ART-* code whenever the historical label is ambiguous.
  if (!nuance || !etat || dimensions.length === 0) return null;

  return [profile, nuance, etat, sousEtat, ...dimensions]
    .filter((value): value is string => Boolean(value))
    .join("-");
}
