import { isMaterialProfileCode, normalizeMaterialProfile } from "../../../shared/codes/material-article-code";

export type MaterialControlDefinition = {
  profile?: string | null;
  grade?: string | null;
  barToCut?: boolean;
  sourceLengthMm?: number | null;
  blankLengthMm?: number | null;
  unitLengthMm?: number | null;
  cutLengthMm?: number | null;
  lengthMm?: number | null;
  widthMm?: number | null;
  heightMm?: number | null;
  thicknessMm?: number | null;
  diameterMm?: number | null;
  acrossFlatsMm?: number | null;
};

export type OperatorDimension = { label: string; valueMm: number | null; minimumMm?: number };

export function operatorMaterialDimensions(material?: MaterialControlDefinition | null): OperatorDimension[] {
  const value = (...values: Array<number | null | undefined>) => values.find(item => typeof item === "number" && Number.isFinite(item) && item > 0) ?? null;
  const length = material?.barToCut ? value(material.sourceLengthMm) :
    value(material?.blankLengthMm, material?.unitLengthMm, material?.cutLengthMm, material?.lengthMm);
  const width = { label: "Largeur", valueMm: value(material?.widthMm) };
  const height = { label: "Hauteur", valueMm: value(material?.heightMm) };
  const thickness = { label: "Épaisseur", valueMm: value(material?.thicknessMm) };
  const diameter = { label: "Diamètre", valueMm: value(material?.diameterMm) };
  const acrossFlats = { label: "Largeur sur plats", valueMm: value(material?.acrossFlatsMm) };
  const profile = isMaterialProfileCode(material?.profile) ? normalizeMaterialProfile(material?.profile) : null;
  const dimensions: OperatorDimension[] = [{ label: "Longueur", valueMm: length }];

  switch (profile) {
    case "RO": return [...dimensions, diameter];
    case "PL": return [...dimensions, width, thickness];
    case "TUBE": return [...dimensions, diameter, thickness];
    case "TUBERECT":
    case "U":
    case "L": return [...dimensions, width, height, thickness];
    case "HEXA": return [...dimensions, acrossFlats];
    default: return [...dimensions, ...[width, height, thickness, diameter, acrossFlats].filter(dimension => dimension.valueMm !== null)];
  }
}

const dimensionLabels = new Map([
  ["longueur_mm", "Longueur"], ["largeur_mm", "Largeur"], ["hauteur_mm", "Hauteur"],
  ["epaisseur_mm", "Épaisseur"], ["diametre_mm", "Diamètre"], ["largeur_plat_mm", "Largeur sur plats"],
]);

export function normalizeOperatorGrade(grade: string) {
  return grade.trim().normalize("NFKC").toUpperCase();
}

export function applyOperatorRequirements(dimensions: OperatorDimension[], grade: string | null, requirements: unknown) {
  if (!Array.isArray(requirements)) return null;
  const byLabel = new Map(dimensions.map(dimension => [dimension.label, dimension]));
  for (const condition of requirements) {
    if (!condition || typeof condition !== "object") return null;
    if (condition.obligatoire === false) continue;
    if (condition.type !== "SPECIFICATION" || typeof condition.valeur !== "string") return null;
    const specification = condition.valeur.trim();
    if (grade && normalizeOperatorGrade(specification) === normalizeOperatorGrade(grade)) continue;
    // Procurement serializes these exact keys as "diametre_mm : 22 mm minimum".
    const match = /^(\w+)\s*:\s*(\d+(?:[.,]\d+)?)\s+mm minimum$/iu.exec(specification);
    const label = match ? dimensionLabels.get(match[1].toLowerCase()) : undefined;
    const dimension = label ? byLabel.get(label) : undefined;
    const minimum = match ? Number(match[2].replace(",", ".")) : NaN;
    if (!dimension || !Number.isFinite(minimum) || minimum <= 0 || minimum > 1e9) return null;
    const scaled = minimum * 1000;
    const supportedMinimum = Math.ceil(scaled - Number.EPSILON * Math.max(1, scaled)) / 1000;
    dimension.minimumMm = Math.max(dimension.minimumMm ?? 0, supportedMinimum);
  }
  return dimensions;
}
