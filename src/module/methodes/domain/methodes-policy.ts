// Gouvernance « Méthodes » — référentiels de gamme et calcul des temps.
// Politiques PURES, sans I/O : capacités RBAC, unité des temps, formules,
// numérotation des phases, exigence de programme, désignation automatique,
// gel du tarif. Testable seul, et fait autorité sur le repository.
//
// TROIS OBJETS DISTINCTS, jamais confondus :
//   1. FAMILLE MACHINE  — classement métier (T, F, TTRAD, FTRAD, DECOUPE…),
//                         référentiel extensible en base, pas un enum figé ;
//   2. CENTRE DE FRAIS  — unité de coût, porteuse du TAUX HORAIRE versionné ;
//   3. MACHINE          — instance physique (ADR-0020), avec son statut et sa
//                         validité calendaire.
// Une machine appartient à une famille ET à un centre de frais ; le centre de
// frais n'est pas la machine, et la famille n'est ni l'un ni l'autre.
//
// UNITÉ DES TEMPS — décision d'audit du 2026-07-29 :
//   la base stocke des HEURES DÉCIMALES. Preuve : `cout_mo = temps_total ×
//   taux_horaire` n'est homogène (€ = h × €/h) que si `temps_total` est en
//   heures ; une opération réelle de `cerp_test` (tp=2.000, taux=50.00) porte
//   cout_mo=105.00 pour temps_total=2.100. Migrer la colonne en minutes
//   invaliderait tous les coûts déjà calculés pour un gain nul.
//   => La base RESTE en heures, l'interface SAISIT en minutes, et TOUTE
//      conversion passe par ce fichier.

import { HttpError } from "../../../utils/httpError";

/* -------------------------------------------------------------------------- */
/* 1) Capacités RBAC — refus par défaut                                       */
/* -------------------------------------------------------------------------- */

export const METHODES_CAPABILITIES = [
  "referentiel_read",
  "referentiel_write",
  "tarif_read",
  "tarif_write",
  "gamme_operation_read",
  "gamme_operation_write",
  "gamme_publish",
] as const;

export type MethodesCapability = (typeof METHODES_CAPABILITIES)[number];

// `req.user.role` porte le rôle EFFECTIF multi-rôles construit à la connexion par
// `authorizationRole()` : une chaîne « Production | Atelier | Method » issue des
// alias d'organigramme. Le vocabulaire réellement produit est donc fermé :
//
//   Directeur · Employee · Administrateur Systeme et Reseau · Responsable Qualité
//   Secretaire · Responsable Programmation · Responsable RH · Commercial · Achat
//   Comptabilite · Production · Atelier · Method · Planification · Logistique
//   Maintenance · Stock · Magasin · Opérateur atelier
//
// Les « needles » ci-dessous sont choisies DANS ce vocabulaire : une needle qui
// ne peut jamais correspondre donnerait l'illusion d'une couverture. Les
// variantes accentuées restent tolérées pour un rôle historique en texte libre.
// Aucun rôle n'obtient de droit implicite.
const CAPABILITY_NEEDLES: Record<MethodesCapability, readonly string[]> = {
  referentiel_read: [
    "admin",
    "directeur",
    "method",
    "méthod",
    "responsable programmation",
    "production",
    "atelier",
    "planification",
    "achat",
    "qualit",
    "compta",
  ],
  // Écrire le référentiel est un acte Méthodes / Programmation.
  referentiel_write: ["admin", "directeur", "method", "méthod", "responsable programmation"],
  // Lire un taux horaire, c'est lire un coût : périmètre plus étroit que le référentiel.
  tarif_read: ["admin", "directeur", "method", "méthod", "compta"],
  // Poser un taux engage le prix de revient : direction et gestion seulement.
  // Les Méthodes CONSOMMENT le tarif, elles ne le fixent pas.
  tarif_write: ["admin", "directeur", "compta"],
  gamme_operation_read: [
    "admin",
    "directeur",
    "method",
    "méthod",
    "responsable programmation",
    "production",
    "atelier",
    "planification",
    "qualit",
  ],
  gamme_operation_write: ["admin", "directeur", "method", "méthod", "responsable programmation"],
  // Publier fige une gamme pour la production : encadrement Méthodes et direction.
  gamme_publish: ["admin", "directeur", "method", "méthod"],
};

export function roleHasMethodesCapability(
  role: string | null | undefined,
  capability: MethodesCapability
): boolean {
  if (hasGrantedAccountModuleAccess()) return true;
  const normalized = (role ?? "").trim().toLowerCase();
  if (!normalized) return false;
  const needles = CAPABILITY_NEEDLES[capability];
  if (!needles) return false;
  return needles.some((needle) => normalized.includes(needle));
}

export function assertMethodesCapability(
  role: string | null | undefined,
  capability: MethodesCapability
): void {
  if (!roleHasMethodesCapability(role, capability)) {
    throw new HttpError(403, "METHODES_CAPABILITY_REQUIRED", `La capacité Méthodes '${capability}' est requise.`);
  }
}

export function methodesCapabilitiesFor(role: string | null | undefined): Record<MethodesCapability, boolean> {
  const out = {} as Record<MethodesCapability, boolean>;
  for (const capability of METHODES_CAPABILITIES) {
    out[capability] = roleHasMethodesCapability(role, capability);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* 2) Unité des temps — heures décimales en base, minutes à la saisie         */
/* -------------------------------------------------------------------------- */

/** Décimales conservées pour une durée stockée en heures (≈ 3,6 ms). */
export const HOUR_STORAGE_DECIMALS = 6;
/** Décimales conservées pour un temps calculé (colonne `numeric(12,4)`). */
export const DERIVED_HOUR_DECIMALS = 4;
/** Décimales conservées quand une durée repart vers l'interface, en minutes. */
export const MINUTE_DISPLAY_DECIMALS = 3;

export const MINUTES_PER_HOUR = 60;

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  const rounded = Math.round(value * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function assertFiniteNonNegative(value: number, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new HttpError(422, "METHODES_NUMBER_INVALID", `Valeur non numérique pour ${field}.`);
  }
  if (value < 0) {
    throw new HttpError(422, "METHODES_NUMBER_NEGATIVE", `Une valeur négative n'est pas acceptée pour ${field}.`);
  }
  return value;
}

/** Minutes saisies → heures décimales stockées. Point de conversion UNIQUE. */
export function minutesToHours(minutes: number, field = "durée"): number {
  return round(assertFiniteNonNegative(minutes, field) / MINUTES_PER_HOUR, HOUR_STORAGE_DECIMALS);
}

/** Heures décimales stockées → minutes affichées. Point de conversion UNIQUE. */
export function hoursToMinutes(hours: number | null | undefined): number | null {
  if (hours === null || hours === undefined) return null;
  if (!Number.isFinite(hours)) return null;
  return round(hours * MINUTES_PER_HOUR, MINUTE_DISPLAY_DECIMALS);
}

/* -------------------------------------------------------------------------- */
/* 3) Formules de temps — jamais saisies manuellement                         */
/* -------------------------------------------------------------------------- */

export type OperationTimeInput = {
  /** Temps de préparation, en heures décimales. */
  temps_preparation: number;
  /** Temps unitaire (cycle), en heures décimales. */
  temps_unitaire: number;
  /** Quantité de base. */
  quantite_base: number;
  /** Coefficient. */
  coefficient: number;
};

export type OperationTimeResult = {
  temps_fabrication: number;
  temps_final: number;
};

/**
 * `temps_fabrication = temps_unitaire × quantité_base × coefficient`
 * `temps_final       = temps_preparation + temps_fabrication`
 *
 * ÉCART ASSUMÉ avec l'implémentation historique `(tp + tf × qte) × coef`, qui
 * appliquait le coefficient AUSSI au temps de préparation. Les deux formules ne
 * divergent que lorsque `coef <> 1` ET `tp <> 0` ; le rapport de candidats du
 * patch chiffre l'écart ligne par ligne sur les données réelles.
 */
export function computeOperationTimes(input: OperationTimeInput): OperationTimeResult {
  const tp = assertFiniteNonNegative(input.temps_preparation, "temps de préparation");
  const tf = assertFiniteNonNegative(input.temps_unitaire, "temps unitaire");
  const qte = assertFiniteNonNegative(input.quantite_base, "quantité de base");
  const coef = assertFiniteNonNegative(input.coefficient, "coefficient");

  const tempsFabrication = round(tf * qte * coef, DERIVED_HOUR_DECIMALS);
  const tempsFinal = round(tp + tempsFabrication, DERIVED_HOUR_DECIMALS);
  return { temps_fabrication: tempsFabrication, temps_final: tempsFinal };
}

/**
 * Coût main-d'œuvre. `null` quand le taux n'est pas connu : un centre de frais
 * sans tarif ne produit PAS un coût de 0 € (ADR-0020 §6 — `0` n'est jamais créé
 * pour remplacer une inconnue).
 */
export function computeLabourCost(tempsFinalHeures: number, taux: number | null): number | null {
  if (taux === null || taux === undefined) return null;
  return round(tempsFinalHeures * taux, 2);
}

/* -------------------------------------------------------------------------- */
/* 4) Numérotation des phases                                                 */
/* -------------------------------------------------------------------------- */

export const PHASE_STEP = 10;
export const PHASE_MIN = 1;
export const PHASE_MAX = 999_999;

/**
 * Phase de la prochaine opération : `max(phase) + 10`, donc 10, 20, 30… sur une
 * gamme vierge. Les phases existantes ne sont JAMAIS renumérotées.
 */
export function nextPhaseNumber(existingPhases: readonly (number | null | undefined)[]): number {
  const valid = existingPhases.filter((p): p is number => typeof p === "number" && Number.isFinite(p));
  if (valid.length === 0) return PHASE_STEP;
  const next = Math.max(...valid) + PHASE_STEP;
  if (next > PHASE_MAX) {
    throw new HttpError(422, "PHASE_RANGE_EXHAUSTED", "La numérotation des phases est saturée pour cette gamme.");
  }
  return next;
}

/**
 * Phase proposée pour une INSERTION entre deux opérations, sans renuméroter
 * quoi que ce soit. `null` en amont = insertion en tête, `null` en aval =
 * insertion en queue. Renvoie `null` quand aucun entier libre n'existe entre
 * les deux : c'est alors une renumérotation explicite qu'il faut demander, pas
 * un décalage silencieux.
 */
export function suggestInsertPhase(
  phaseBefore: number | null | undefined,
  phaseAfter: number | null | undefined
): number | null {
  const before = typeof phaseBefore === "number" && Number.isFinite(phaseBefore) ? phaseBefore : null;
  const after = typeof phaseAfter === "number" && Number.isFinite(phaseAfter) ? phaseAfter : null;

  if (before === null && after === null) return PHASE_STEP;
  if (before === null) {
    const candidate = Math.floor((after as number) / 2);
    return candidate >= PHASE_MIN && candidate < (after as number) ? candidate : null;
  }
  if (after === null) {
    const candidate = before + PHASE_STEP;
    return candidate <= PHASE_MAX ? candidate : null;
  }
  if (after - before < 2) return null;
  return before + Math.floor((after - before) / 2);
}

/** Une phase déjà prise n'est jamais écrasée ni décalée en silence. */
export function assertPhaseAvailable(
  existingPhases: readonly (number | null | undefined)[],
  phase: number,
  ignoreOperationPhase?: number | null
): void {
  if (!Number.isInteger(phase) || phase < PHASE_MIN || phase > PHASE_MAX) {
    throw new HttpError(
      422,
      "PHASE_INVALID",
      `Le numéro de phase doit être un entier entre ${PHASE_MIN} et ${PHASE_MAX}.`
    );
  }
  if (typeof ignoreOperationPhase === "number" && ignoreOperationPhase === phase) return;
  if (existingPhases.some((p) => p === phase)) {
    throw new HttpError(
      409,
      "PHASE_ALREADY_USED",
      `La phase ${phase} existe déjà dans cette gamme. Choisissez un autre numéro : les phases existantes ne sont pas renumérotées automatiquement.`
    );
  }
}

/* -------------------------------------------------------------------------- */
/* 5) Familles machine et numéro de programme                                 */
/* -------------------------------------------------------------------------- */

export type MachineFamilyRef = {
  code: string;
  libelle: string;
  programme_requis: boolean;
  actif: boolean;
};

export const PROGRAM_NUMBER_MAX_LENGTH = 60;

/** `"  o1234 "` → `"O1234"`. Chaîne vide → `null` (« pas de programme »). */
export function normalizeProgramNumber(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const collapsed = String(value).replace(/\s+/g, " ").trim().toUpperCase();
  if (collapsed === "") return null;
  if (collapsed.length > PROGRAM_NUMBER_MAX_LENGTH) {
    throw new HttpError(
      422,
      "PROGRAM_NUMBER_TOO_LONG",
      `Le numéro de programme dépasse ${PROGRAM_NUMBER_MAX_LENGTH} caractères.`
    );
  }
  return collapsed;
}

/**
 * Le numéro de programme est obligatoire pour les familles qui le déclarent
 * (`programme_requis`), c'est-à-dire `T` et `F` à l'amorçage. Il reste
 * facultatif pour `TTRAD`, `FTRAD` et `DECOUPE`. L'exigence vient du
 * RÉFÉRENTIEL, pas d'une liste codée en dur : ajouter une famille CN suffit.
 */
export function assertProgramNumberRequirement(params: {
  family: MachineFamilyRef | null;
  numero_programme: string | null;
}): void {
  const { family, numero_programme } = params;
  if (!family?.programme_requis) return;
  if (numero_programme === null) {
    throw new HttpError(
      422,
      "PROGRAM_NUMBER_REQUIRED",
      `Le numéro de programme est obligatoire pour la famille ${family.code} (${family.libelle}).`,
      { field: "numero_programme", family_code: family.code }
    );
  }
}

export function assertFamilySelectable(family: MachineFamilyRef | null, familyCode: string | null): void {
  if (familyCode === null) return;
  if (!family) {
    throw new HttpError(422, "MACHINE_FAMILY_UNKNOWN", `Famille machine inconnue : ${familyCode}.`);
  }
  if (!family.actif) {
    throw new HttpError(
      422,
      "MACHINE_FAMILY_INACTIVE",
      `La famille ${family.code} est désactivée : elle reste lisible dans l'historique mais ne se choisit plus.`
    );
  }
}

/* -------------------------------------------------------------------------- */
/* 6) Machine — utilisable ou non                                             */
/* -------------------------------------------------------------------------- */

export type MachineRef = {
  id: string;
  code: string;
  name: string;
  status: string;
  archived_at: string | null;
  valid_from: string | null;
  valid_to: string | null;
  machine_family_code: string | null;
};

/** `YYYY-MM-DD` — comparaison de dates sans piège de fuseau. */
export function toIsoDate(value: Date | string): string {
  if (typeof value === "string") return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}

/**
 * Une machine archivée, hors service, en maintenance ou hors de sa période de
 * validité ne se pose pas sur une NOUVELLE opération. Les opérations existantes
 * la conservent : l'historique ne se réécrit pas.
 */
export function assertMachineSelectable(machine: MachineRef | null, machineId: string | null, at: string): void {
  if (machineId === null) return;
  if (!machine) {
    throw new HttpError(422, "MACHINE_UNKNOWN", "Machine inconnue.");
  }
  if (machine.archived_at) {
    throw new HttpError(422, "MACHINE_ARCHIVED", `La machine ${machine.code} est archivée.`);
  }
  if (machine.status !== "ACTIVE") {
    throw new HttpError(
      422,
      "MACHINE_NOT_ACTIVE",
      `La machine ${machine.code} n'est pas active (${machine.status}).`,
      { machine_status: machine.status }
    );
  }
  if (machine.valid_from && at < machine.valid_from) {
    throw new HttpError(
      422,
      "MACHINE_NOT_YET_VALID",
      `La machine ${machine.code} n'est valide qu'à partir du ${machine.valid_from}.`
    );
  }
  if (machine.valid_to && at > machine.valid_to) {
    throw new HttpError(
      422,
      "MACHINE_NO_LONGER_VALID",
      `La machine ${machine.code} n'est plus valide depuis le ${machine.valid_to}.`
    );
  }
}

/**
 * La machine et la famille de l'opération doivent concorder. Aucune
 * classification n'est déduite d'un libellé : si la machine n'a pas de famille
 * renseignée, on le DIT, on ne devine pas.
 */
export function assertMachineFamilyConsistent(machine: MachineRef | null, familyCode: string | null): void {
  if (!machine || familyCode === null) return;
  if (machine.machine_family_code === null) {
    throw new HttpError(
      422,
      "MACHINE_FAMILY_MISSING",
      `La famille de la machine ${machine.code} n'est pas renseignée dans le référentiel : complétez la fiche machine avant de l'utiliser sur une gamme.`,
      { machine_code: machine.code }
    );
  }
  if (machine.machine_family_code !== familyCode) {
    throw new HttpError(
      422,
      "MACHINE_FAMILY_MISMATCH",
      `La machine ${machine.code} appartient à la famille ${machine.machine_family_code}, pas à ${familyCode}.`
    );
  }
}

/* -------------------------------------------------------------------------- */
/* 7) Centre de frais et tarif applicable                                     */
/* -------------------------------------------------------------------------- */

export type CostCenterRef = {
  id: string;
  code: string;
  designation: string;
  statut: string;
  devise: string;
  machine_family_code: string | null;
  designation_auto: boolean;
  designation_modele: string | null;
};

export type CostCenterRate = {
  id: string;
  taux_horaire: number;
  devise: string;
  date_effet: string;
  date_fin: string | null;
};

export function assertCostCenterSelectable(cf: CostCenterRef | null, cfId: string | null): void {
  if (cfId === null) return;
  if (!cf) {
    throw new HttpError(422, "COST_CENTER_UNKNOWN", "Centre de frais inconnu.");
  }
  if (cf.statut !== "ACTIF") {
    throw new HttpError(
      422,
      "COST_CENTER_NOT_ACTIVE",
      `Le centre de frais ${cf.code} n'est pas actif (${cf.statut}).`,
      { statut: cf.statut }
    );
  }
}

/** Tarif en vigueur à une date donnée. Le plus récent qui a pris effet gagne. */
export function pickApplicableRate(rates: readonly CostCenterRate[], at: string): CostCenterRate | null {
  const eligible = rates
    .filter((rate) => rate.date_effet <= at && (rate.date_fin === null || rate.date_fin >= at))
    .sort((left, right) => (left.date_effet < right.date_effet ? 1 : left.date_effet > right.date_effet ? -1 : 0));
  return eligible[0] ?? null;
}

export type FrozenRate = {
  taux_horaire: number;
  /** `null` tant qu'aucun tarif n'est applicable : le taux n'est pas « 0 €/h ». */
  taux_horaire_connu: number | null;
  cf_rate_id: string | null;
  taux_horaire_source: "CENTRE_FRAIS" | "ABSENT";
  taux_horaire_effective_at: string | null;
  devise: string | null;
};

/**
 * Gèle le tarif sur l'opération. Un centre de frais SANS tarif ne bloque pas la
 * saisie d'un brouillon de gamme — mais il ne fabrique pas un coût : la colonne
 * `taux_horaire` reste à 0 (NOT NULL en base) tandis que `taux_horaire_source`
 * vaut `ABSENT` et que le coût main-d'œuvre exposé est `null`.
 */
export function freezeRate(rate: CostCenterRate | null): FrozenRate {
  if (!rate) {
    return {
      taux_horaire: 0,
      taux_horaire_connu: null,
      cf_rate_id: null,
      taux_horaire_source: "ABSENT",
      taux_horaire_effective_at: null,
      devise: null,
    };
  }
  return {
    taux_horaire: rate.taux_horaire,
    taux_horaire_connu: rate.taux_horaire,
    cf_rate_id: rate.id,
    taux_horaire_source: "CENTRE_FRAIS",
    taux_horaire_effective_at: rate.date_effet,
    devise: rate.devise,
  };
}

/**
 * Un nouveau tarif ne réécrit jamais l'ancien : il le clôt. Sa date d'effet doit
 * donc être strictement postérieure à celle du tarif ouvert.
 */
export function assertRateSupersedes(current: CostCenterRate | null, nextEffectiveAt: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(nextEffectiveAt)) {
    throw new HttpError(422, "RATE_DATE_INVALID", "La date d'effet doit être au format AAAA-MM-JJ.");
  }
  if (!current) return;
  if (nextEffectiveAt <= current.date_effet) {
    throw new HttpError(
      409,
      "RATE_DATE_NOT_AFTER_CURRENT",
      `Le tarif en vigueur prend effet le ${current.date_effet} : la nouvelle date d'effet doit lui être postérieure. L'historique n'est jamais réécrit.`
    );
  }
}

/* -------------------------------------------------------------------------- */
/* 8) Désignation d'opération — générable, puis FIGÉE à la publication        */
/* -------------------------------------------------------------------------- */

export const OPERATION_DESIGNATION_MAX_LENGTH = 200;

/** Liste blanche EXHAUSTIVE des variables d'un modèle de désignation. */
export const DESIGNATION_TEMPLATE_VARIABLES = [
  "cf_code",
  "cf_designation",
  "famille_code",
  "famille_libelle",
  "machine_code",
  "machine_nom",
  "numero_programme",
  "phase",
  "type_operation",
] as const;
export type DesignationTemplateVariable = (typeof DESIGNATION_TEMPLATE_VARIABLES)[number];

export const DEFAULT_DESIGNATION_TEMPLATE = "{cf_designation}";

const TEMPLATE_TOKEN = /\{([a-z_]+)\}/g;

export function assertDesignationTemplateAllowed(template: string): void {
  const unknown = new Set<string>();
  for (const match of template.matchAll(TEMPLATE_TOKEN)) {
    if (!(DESIGNATION_TEMPLATE_VARIABLES as readonly string[]).includes(match[1])) unknown.add(match[1]);
  }
  if (unknown.size > 0) {
    throw new HttpError(422, "DESIGNATION_TEMPLATE_VARIABLE_FORBIDDEN", "Le modèle de désignation utilise une variable non autorisée.", {
      forbidden: [...unknown].sort(),
    });
  }
}

/** Neutralise ce qui transformerait une valeur métier en gabarit ou en balise. */
function sanitizeDesignationValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value)
    // Caracteres de controle : jamais dans un texte metier.
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/[<>{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateReadable(value: string, max: number): string {
  if (value.length <= max) return value;
  const hard = value.slice(0, max - 1);
  const lastSpace = hard.lastIndexOf(" ");
  const base = lastSpace > max * 0.6 ? hard.slice(0, lastSpace) : hard;
  return `${base.trimEnd()}…`;
}

/**
 * Rend la désignation depuis la règle du centre de frais. Renvoie `null` si le
 * rendu est vide : mieux vaut « pas de désignation » qu'un texte à trous.
 */
export function buildOperationDesignation(
  template: string | null | undefined,
  values: Partial<Record<DesignationTemplateVariable, unknown>>
): string | null {
  const model = (template ?? "").trim() === "" ? DEFAULT_DESIGNATION_TEMPLATE : (template as string);
  assertDesignationTemplateAllowed(model);
  const rendered = model
    .replace(TEMPLATE_TOKEN, (_full, name: string) => sanitizeDesignationValue(values[name as DesignationTemplateVariable]))
    .replace(/\s+/g, " ")
    .replace(/^[\s\-—·,;]+|[\s\-—·,;]+$/g, "")
    .trim();
  return rendered === "" ? null : truncateReadable(rendered, OPERATION_DESIGNATION_MAX_LENGTH);
}

export type DesignationResolution = {
  designation: string | null;
  designation_auto: boolean;
};

/**
 * Désignation d'une opération en cours de saisie. La saisie manuelle gagne
 * toujours ; à défaut, la règle du centre de frais s'applique ; à défaut, la
 * désignation reste vide — ce qui est TOLÉRÉ EN BROUILLON et refusé à la
 * publication (`assertGammePublishable`).
 */
export function resolveOperationDesignation(params: {
  saisie: string | null | undefined;
  costCenter: CostCenterRef | null;
  values: Partial<Record<DesignationTemplateVariable, unknown>>;
}): DesignationResolution {
  const manual = sanitizeDesignationValue(params.saisie);
  if (manual !== "") {
    return { designation: truncateReadable(manual, OPERATION_DESIGNATION_MAX_LENGTH), designation_auto: false };
  }
  const cf = params.costCenter;
  if (cf?.designation_auto) {
    const generated = buildOperationDesignation(cf.designation_modele, {
      ...params.values,
      cf_code: cf.code,
      cf_designation: cf.designation,
    });
    if (generated) return { designation: generated, designation_auto: true };
  }
  return { designation: null, designation_auto: false };
}

/* -------------------------------------------------------------------------- */
/* 9) Cycle de vie de la gamme                                                */
/* -------------------------------------------------------------------------- */

export const EDITABLE_GAMME_STATUSES = ["BROUILLON", "EN_VALIDATION"] as const;

export function assertGammeEditable(statut: string | null | undefined): void {
  const normalized = (statut ?? "").trim().toUpperCase();
  if (!(EDITABLE_GAMME_STATUSES as readonly string[]).includes(normalized)) {
    throw new HttpError(
      409,
      "GAMME_NOT_EDITABLE",
      "Cette gamme n'est plus modifiable : créez une nouvelle gamme ou un nouvel indice."
    );
  }
}

export type PublishableOperation = {
  id: string;
  phase: number | null;
  designation: string | null;
  machine_family_code: string | null;
  numero_programme: string | null;
};

export type PublicationBlocker = {
  operation_id: string;
  phase: number | null;
  code: string;
  message: string;
};

/**
 * Une gamme publiée ne contient JAMAIS une opération sans désignation figée, ni
 * une opération de famille CN sans numéro de programme. On renvoie TOUS les
 * blocages d'un coup : corriger à l'aveugle, un blocage après l'autre, est une
 * perte de temps pour les Méthodes.
 */
export function collectPublicationBlockers(
  operations: readonly PublishableOperation[],
  families: ReadonlyMap<string, MachineFamilyRef>
): PublicationBlocker[] {
  const blockers: PublicationBlocker[] = [];
  if (operations.length === 0) {
    blockers.push({
      operation_id: "",
      phase: null,
      code: "GAMME_EMPTY",
      message: "Une gamme applicable contient au moins une opération.",
    });
  }
  for (const operation of operations) {
    if (!operation.designation || operation.designation.trim() === "") {
      blockers.push({
        operation_id: operation.id,
        phase: operation.phase,
        code: "OPERATION_DESIGNATION_REQUIRED",
        message: `Phase ${operation.phase ?? "?"} : la désignation doit être figée avant publication.`,
      });
    }
    const family = operation.machine_family_code ? families.get(operation.machine_family_code) ?? null : null;
    if (family?.programme_requis && !operation.numero_programme) {
      blockers.push({
        operation_id: operation.id,
        phase: operation.phase,
        code: "PROGRAM_NUMBER_REQUIRED",
        message: `Phase ${operation.phase ?? "?"} : le numéro de programme est obligatoire pour la famille ${family.code}.`,
      });
    }
  }
  return blockers;
}

export function assertGammePublishable(
  operations: readonly PublishableOperation[],
  families: ReadonlyMap<string, MachineFamilyRef>
): void {
  const blockers = collectPublicationBlockers(operations, families);
  if (blockers.length > 0) {
    throw new HttpError(422, "GAMME_NOT_PUBLISHABLE", "Cette gamme ne peut pas être publiée en l'état.", {
      blockers,
    });
  }
}

/* -------------------------------------------------------------------------- */
/* 10) Verrou optimiste                                                       */
/* -------------------------------------------------------------------------- */

export function assertOptimisticVersion(params: {
  expectedUpdatedAt: string | null | undefined;
  currentUpdatedAt: string | Date;
  label: string;
}): void {
  const expected = (params.expectedUpdatedAt ?? "").trim();
  if (!expected) {
    throw new HttpError(422, "EXPECTED_VERSION_REQUIRED", `expected_updated_at est obligatoire pour modifier ${params.label}.`);
  }
  const current =
    params.currentUpdatedAt instanceof Date
      ? params.currentUpdatedAt.toISOString()
      : new Date(params.currentUpdatedAt).toISOString();
  const parsed = new Date(expected);
  if (Number.isNaN(parsed.getTime())) {
    throw new HttpError(422, "EXPECTED_VERSION_INVALID", "expected_updated_at est invalide.");
  }
  if (parsed.toISOString() !== current) {
    throw new HttpError(
      409,
      "CONCURRENT_MODIFICATION",
      `${params.label} a été modifié entre-temps : rechargez avant de confirmer.`
    );
  }
}
import { hasGrantedAccountModuleAccess } from "../../access-control/context/account-module-access.context";
