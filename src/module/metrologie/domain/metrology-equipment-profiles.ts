// Profils de fiche MD15 issus du système documentaire qualité historique.
//
// Un profil guide la saisie et le relevé, il ne décide jamais du verdict. Les
// étalons, nominaux et tolérances varient par instrument et restent définis
// dans le plan/exécution versionné.

export type MetrologyProfileField = {
  key: string;
  label: string;
  value_kind: "text" | "date" | "number" | "boolean";
  required: boolean;
  unit?: string;
};

export type MetrologyProfilePoint = {
  key: string;
  label: string;
  kind: "EXTERNAL" | "INTERNAL" | "DEPTH" | "REFERENCE";
  unit: string;
  reference_hint?: string;
};

export type MetrologyEquipmentProfile = {
  code: string;
  label: string;
  code_prefix: string;
  categorie_code: string;
  /** Première valeur auto proposée après le dernier dossier historique observé. */
  min_next_number: number;
  fields: MetrologyProfileField[];
  measurement_points: MetrologyProfilePoint[];
};

const COMMON_FIELDS: MetrologyProfileField[] = [
  { key: "COCONTR", label: "Référence historique complète", value_kind: "text", required: false },
  { key: "IDCONTROLE", label: "Identifiant historique", value_kind: "text", required: false },
  { key: "PRECIS", label: "Précision historique", value_kind: "text", required: false },
  { key: "PERIOD", label: "Périodicité historique", value_kind: "text", required: false },
  { key: "DATEENTR", label: "Date d'entrée", value_kind: "date", required: false },
  { key: "DATEDERN", label: "Dernier contrôle", value_kind: "date", required: false },
  { key: "REBUT", label: "Rebut historique", value_kind: "boolean", required: false },
  { key: "ETREF", label: "ETREF historique", value_kind: "text", required: false },
  { key: "MIREF", label: "MIREF historique", value_kind: "text", required: false },
  { key: "MAREF", label: "MAREF historique", value_kind: "text", required: false },
  { key: "APMI", label: "APMI historique", value_kind: "text", required: false },
  { key: "APMA", label: "APMA historique", value_kind: "text", required: false },
  { key: "CODEEMP", label: "Affectation historique", value_kind: "text", required: false },
  { key: "COSERVICE", label: "Service historique", value_kind: "text", required: false },
  { key: "DATESO", label: "Date de sortie", value_kind: "date", required: false },
  { key: "TYPEP_RIODE", label: "Type de période historique", value_kind: "text", required: false },
  { key: "OBS", label: "Observation historique", value_kind: "text", required: false },
];

const profiles: readonly MetrologyEquipmentProfile[] = [
  {
    code: "PC", label: "Pied à coulisse", code_prefix: "PC", categorie_code: "PIED_A_COULISSE", min_next_number: 59,
    fields: COMMON_FIELDS,
    measurement_points: [
      { key: "EXTERNAL_25_FULL", label: "Extérieur 25 mm — pleine cale", kind: "EXTERNAL", unit: "mm", reference_hint: "Première cale à confirmer" },
      { key: "EXTERNAL_25_TIPS", label: "Extérieur 25 mm — bouts de becs", kind: "EXTERNAL", unit: "mm", reference_hint: "Première cale à confirmer" },
      { key: "EXTERNAL_75_FULL", label: "Extérieur 75 mm — pleine cale", kind: "EXTERNAL", unit: "mm", reference_hint: "Deuxième cale à confirmer" },
      { key: "EXTERNAL_75_TIPS", label: "Extérieur 75 mm — bouts de becs", kind: "EXTERNAL", unit: "mm", reference_hint: "Deuxième cale à confirmer" },
      { key: "INTERNAL_1", label: "Intérieur — première bague", kind: "INTERNAL", unit: "mm", reference_hint: "Bague à confirmer" },
      { key: "INTERNAL_2", label: "Intérieur — seconde bague", kind: "INTERNAL", unit: "mm", reference_hint: "Bague à confirmer" },
      { key: "DEPTH_25", label: "Profondeur 25 mm", kind: "DEPTH", unit: "mm", reference_hint: "Cale à confirmer" },
      { key: "DEPTH_75", label: "Profondeur 75 mm", kind: "DEPTH", unit: "mm", reference_hint: "Cale à confirmer" },
    ],
  },
  {
    code: "JP", label: "Jauge de profondeur", code_prefix: "JP", categorie_code: "CALIBRE", min_next_number: 8,
    fields: COMMON_FIELDS,
    measurement_points: [
      { key: "DEPTH_25", label: "Profondeur 25 mm", kind: "DEPTH", unit: "mm", reference_hint: "Première cale à confirmer" },
      { key: "DEPTH_75", label: "Profondeur 75 mm", kind: "DEPTH", unit: "mm", reference_hint: "Deuxième cale à confirmer" },
    ],
  },
  {
    code: "ME", label: "Micromètre extérieur", code_prefix: "ME", categorie_code: "MICROMETRE", min_next_number: 27,
    fields: COMMON_FIELDS,
    measurement_points: [{ key: "EXTERNAL", label: "Mesure extérieure", kind: "EXTERNAL", unit: "mm", reference_hint: "Cale adaptée à la plage" }],
  },
  {
    code: "MI", label: "Micromètre intérieur", code_prefix: "MI", categorie_code: "MICROMETRE", min_next_number: 19,
    fields: COMMON_FIELDS,
    measurement_points: [{ key: "INTERNAL", label: "Mesure intérieure", kind: "INTERNAL", unit: "mm", reference_hint: "Bague adaptée à l'appareil" }],
  },
  {
    code: "MES", label: "Rugosimètre", code_prefix: "MES", categorie_code: "MACHINE_MESURE", min_next_number: 3,
    fields: COMMON_FIELDS,
    measurement_points: [{ key: "REFERENCE", label: "Étalon de rugosité", kind: "REFERENCE", unit: "µm" }],
  },
  { code: "BF", label: "Bague filetée", code_prefix: "BF", categorie_code: "CALIBRE", min_next_number: 66, fields: COMMON_FIELDS, measurement_points: [] },
  { code: "BL", label: "Bague de contrôle", code_prefix: "BL", categorie_code: "CALIBRE", min_next_number: 22, fields: COMMON_FIELDS, measurement_points: [] },
  { code: "CA", label: "Cale étalon", code_prefix: "CA", categorie_code: "ETALON", min_next_number: 5, fields: COMMON_FIELDS, measurement_points: [] },
  { code: "OUT", label: "Outillage divers", code_prefix: "OUT", categorie_code: "AUTRE", min_next_number: 8, fields: COMMON_FIELDS, measurement_points: [] },
  { code: "TF", label: "Tampon fileté", code_prefix: "TF", categorie_code: "CALIBRE", min_next_number: 111, fields: COMMON_FIELDS, measurement_points: [] },
  { code: "TFD", label: "Tampon fileté double", code_prefix: "TFD", categorie_code: "CALIBRE", min_next_number: 4, fields: COMMON_FIELDS, measurement_points: [] },
  { code: "TLD", label: "Tampon lisse", code_prefix: "TLD", categorie_code: "CALIBRE", min_next_number: 51, fields: COMMON_FIELDS, measurement_points: [] },
];

export function listMetrologyEquipmentProfiles(): readonly MetrologyEquipmentProfile[] {
  return profiles;
}

export function findMetrologyEquipmentProfile(code: string | null | undefined): MetrologyEquipmentProfile | null {
  const normalized = (code ?? "").trim().toUpperCase();
  return profiles.find((profile) => profile.code === normalized) ?? null;
}

/** Lit uniquement le namespace possédé par la fiche MD15, sans interpréter les
 * autres spécifications (qui restent compatibles avec le registre existant). */
export function metrologyProfileCodeFromSpecifications(specifications: unknown): string | null {
  if (typeof specifications !== "object" || specifications === null || Array.isArray(specifications)) return null;
  const fiche = (specifications as Record<string, unknown>).fiche_metrologie;
  if (typeof fiche !== "object" || fiche === null || Array.isArray(fiche)) return null;
  const code = (fiche as Record<string, unknown>).profile_code;
  return typeof code === "string" && code.trim() ? code.trim().toUpperCase() : null;
}

/** Fusion superficielle volontairement non destructive des métadonnées JSON.
 * Une fiche MD15 est atomique et validée en entier par le DTO avant écriture. */
export function mergeMetrologySpecifications(existing: unknown, incoming: unknown): Record<string, unknown> {
  const prior = typeof existing === "object" && existing !== null && !Array.isArray(existing)
    ? existing as Record<string, unknown>
    : {};
  const next = typeof incoming === "object" && incoming !== null && !Array.isArray(incoming)
    ? incoming as Record<string, unknown>
    : {};
  return { ...prior, ...next };
}

/** Une exécution sans profil reste possible pour les instruments historiques;
 * dès qu'une fiche instrument existe, elle interdit seulement un profil différent. */
export function executionProfileMatchesEquipment(
  instrumentProfileCode: string | null,
  executionProfileCode: string | null
): boolean {
  return !instrumentProfileCode || !executionProfileCode || instrumentProfileCode === executionProfileCode;
}
