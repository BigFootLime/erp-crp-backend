export const CODE_FORMATS = {
  client: {
    regex: /^CLI-\d{3}$/,
    example: "CLI-001",
    hintText: "Format attendu: CLI-001",
  },
  devis: {
    // Legacy DV-<id> is still accepted for existing data.
    regex: /^(DEV-CLI-\d{3}-\d{4}-\d{4}|DV-\d+)$/,
    example: "DEV-CLI-001-2026-0001",
    hintText: "Format attendu: DEV-CLI-001-2026-0001",
  },
  commande: {
    // Legacy CC-<id> is still accepted for existing data.
    regex: /^(CC-CLI-\d{3}-\d{4}-\d{4}|CC-\d+)$/,
    example: "CC-CLI-001-2026-0001",
    hintText: "Format attendu: CC-CLI-001-2026-0001",
  },
  affaire: {
    // Legacy AFF-<id> is still accepted for existing data.
    regex: /^(AFF-(LIV|PROD)-CLI-\d{3}-\d{4}-\d{4}|AFF-\d+)$/,
    example: "AFF-PROD-CLI-001-2026-0001",
    hintText: "Format attendu: AFF-(LIV|PROD)-CLI-001-2026-0001",
  },
  pieceTechnique: {
    // Legacy patterns are still accepted for existing data.
    regex: /^(PCT-CLI-\d{3}-\d{4}|P-\d{3,})$/,
    example: "PCT-CLI-001-0001",
    hintText: "Format attendu: PCT-CLI-001-0001",
  },
  of: {
    // Legacy OF-<id> is still accepted for existing data.
    regex: /^(OF-\d{4}-\d{5}|OF-\d+)$/,
    example: "OF-2026-00001",
    hintText: "Format attendu: OF-2026-00001",
  },
  bonLivraison: {
    // Current production format.
    regex: /^BL-\d{8}$/,
    example: "BL-00000001",
    hintText: "Format attendu: BL-00000001",
  },
  reception: {
    // Current production format.
    regex: /^RF-\d{8}$/,
    example: "RF-00000001",
    hintText: "Format attendu: RF-00000001",
  },
  fournisseur: {
    regex: /^FOU-\d{3}$/,
    example: "FOU-001",
    hintText: "Format attendu: FOU-001",
  },
  article: {
    regex: /^ART-\d{4}$/,
    example: "ART-0001",
    hintText: "Format attendu: ART-0001",
  },
  nonConformity: {
    // Matches existing generator in DB.
    regex: /^NC-\d{4}-\d{5}$/,
    example: "NC-2026-00001",
    hintText: "Format attendu: NC-2026-00001",
  },
  capa: {
    // Introduced by db/patches/20260227_nomenclature_codes.sql
    regex: /^CAP-\d{4}-\d{5}$/,
    example: "CAP-2026-00001",
    hintText: "Format attendu: CAP-2026-00001",
  },
} as const;

export type CodeFormatKey = keyof typeof CODE_FORMATS;

export function isValidCode(format: CodeFormatKey, value: string): boolean {
  const v = value.trim();
  if (!v) return false;
  return CODE_FORMATS[format].regex.test(v);
}

export function codeFormatHintText(format: CodeFormatKey): string {
  return CODE_FORMATS[format].hintText;
}

export function codeFormatExample(format: CodeFormatKey): string {
  return CODE_FORMATS[format].example;
}
