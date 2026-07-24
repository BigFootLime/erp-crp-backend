export const CODE_FORMATS = {
  client: {
    regex: /^CLI-\d{3}$/,
    example: "CLI-001",
    hintText: "Format attendu: CLI-001",
  },
  devis: {
    regex: /^(DEV-\d{4}-\d{4}(?:-V\d+)?|DV-\d+)$/,
    example: "DEV-2026-0001",
    hintText: "Format attendu: DEV-2026-0001",
  },
  commande: {
    regex: /^(CMD-\d{4}-\d{4}|CC-\d+)$/,
    example: "CMD-2026-0001",
    hintText: "Format attendu: CMD-2026-0001",
  },
  affaire: {
    regex: /^(AFF-\d{4}-\d{4}|AFF-LIV-CLI-\d{3}-\d{4}-\d{4}|AFF-\d+)$/,
    example: "AFF-2026-0001",
    hintText: "Format attendu: AFF-2026-0001",
  },
  pieceTechnique: {
    regex: /^(?:[A-Z0-9]+-[A-Z0-9]+-[A-Z0-9]+|P-\d{3,})$/,
    example: "001-17025950000-C",
    hintText: "Format attendu: 001-17025950000-C",
  },
  of: {
    regex: /^(OF-\d{4}-\d{6}|OF-\d{4}-\d{5}|OF-\d+)$/,
    example: "OF-2026-000001",
    hintText: "Format attendu: OF-2026-000001",
  },
  bonLivraison: {
    regex: /^BL-\d{8}$/,
    example: "BL-00000001",
    hintText: "Format attendu: BL-00000001",
  },
  reception: {
    regex: /^RF-\d{8}$/,
    example: "RF-00000001",
    hintText: "Format attendu: RF-00000001",
  },
  fournisseur: {
    regex: /^FOU-\d{3}$/,
    example: "FOU-001",
    hintText: "Format attendu: FOU-001",
  },
  commandeFournisseur: {
    regex: /^BCF-\d{4}-\d{4}$/,
    example: "BCF-2026-0001",
    hintText: "Format attendu: BCF-2026-0001",
  },
  article: {
    regex: /^(ART-[A-Z0-9]+-\d{6}|ART-\d{4})$/,
    example: "ART-USI-000042",
    hintText: "Format attendu: ART-USI-000042",
  },
  nonConformity: {
    regex: /^NC-\d{4}-\d{5}$/,
    example: "NC-2026-00001",
    hintText: "Format attendu: NC-2026-00001",
  },
  capa: {
    regex: /^(CAPA|CAP)-\d{4}-\d{5,6}$/,
    example: "CAPA-2026-000001",
    hintText: "Format cible: CAPA-2026-000001 (CAP historique accepté)",
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
