// Gouvernance « Bibliothèque de finitions » (#210 / web #339) — politiques pures, sans I/O.
//
// Ce fichier concentre tout ce qui ne doit dépendre ni d'un client SQL, ni du
// réseau, ni du navigateur : capacités RBAC, cycles de vie, normalisation des
// unités, spécification canonique, empreinte anti-doublon, idempotence et
// verrou optimiste. Il est testable seul et fait autorité.
//
// Principe directeur (ADR-0038) : la FINITION décrit une exigence ; l'ARTICLE
// est la prestation achetable qui en découle pour une pièce et un indice
// donnés. Le fournisseur, le prix, le délai et le MOQ n'entrent JAMAIS dans
// l'identité technique — ils appartiennent au catalogue fournisseur.

import crypto from "node:crypto";

import { HttpError } from "../../../utils/httpError";

/* -------------------------------------------------------------------------- */
/* 1) Capacités RBAC — refus par défaut                                       */
/* -------------------------------------------------------------------------- */

export const SURFACE_FINISH_CAPABILITIES = [
  "library_read",
  "library_draft_create",
  "library_draft_write",
  "library_submit",
  "library_approve",
  "library_retire",
  "documents_read",
  "documents_write",
  "operation_configure",
  "article_preview",
  "article_resolve",
  "article_force_create",
  "generated_text_override",
  "costs_read",
  "supplier_qualification_manage",
  "audit_read",
] as const;

export type SurfaceFinishCapability = (typeof SURFACE_FINISH_CAPABILITIES)[number];

// Les rôles CERP sont du texte libre en base : on garde la mécanique par
// « needles » déjà utilisée par `metrology-policy.ts` et `quality-policy.ts`
// plutôt que d'inventer une table de rôles parallèle.
//
// Aucun rôle n'obtient de droit implicite. La bibliothèque est un référentiel
// Méthodes/Qualité ; les Achats la LISENT sans pouvoir la réécrire.
const CAPABILITY_NEEDLES: Record<SurfaceFinishCapability, readonly string[]> = {
  library_read: [
    "admin",
    "administrateur",
    "directeur",
    "method",
    "méthod",
    "bureau",
    "qualit",
    "quality",
    "qse",
    "achat",
    "approvision",
    "production",
    "atelier",
  ],
  library_draft_create: ["admin", "administrateur", "directeur", "method", "méthod", "bureau", "qualit", "quality", "qse"],
  library_draft_write: ["admin", "administrateur", "directeur", "method", "méthod", "bureau", "qualit", "quality", "qse"],
  library_submit: ["admin", "administrateur", "directeur", "method", "méthod", "bureau", "qualit", "quality", "qse"],
  // Approuver une révision engage la conformité produit : jamais les Achats.
  library_approve: ["admin", "administrateur", "directeur", "qualit", "quality", "qse", "method", "méthod"],
  library_retire: ["admin", "administrateur", "directeur", "qualit", "quality", "qse", "method", "méthod"],
  documents_read: [
    "admin",
    "administrateur",
    "directeur",
    "method",
    "méthod",
    "bureau",
    "qualit",
    "quality",
    "qse",
    "achat",
    "approvision",
  ],
  documents_write: ["admin", "administrateur", "directeur", "method", "méthod", "bureau", "qualit", "quality", "qse"],
  // Configurer une opération de gamme est un acte Méthodes.
  operation_configure: ["admin", "administrateur", "directeur", "method", "méthod", "bureau"],
  article_preview: ["admin", "administrateur", "directeur", "method", "méthod", "bureau", "achat", "approvision"],
  article_resolve: ["admin", "administrateur", "directeur", "method", "méthod", "bureau"],
  // Forcer un article distinct alors qu'un article exact existe : décision rare,
  // justifiée, auditée. Réservée à l'encadrement Méthodes et à la direction.
  article_force_create: ["admin", "administrateur", "directeur", "responsable method", "responsable méthod"],
  generated_text_override: ["admin", "administrateur", "directeur", "responsable method", "responsable méthod"],
  costs_read: ["admin", "administrateur", "directeur", "achat", "approvision", "compta", "finance", "controle de gestion"],
  supplier_qualification_manage: ["admin", "administrateur", "directeur", "achat", "approvision", "qualit", "quality", "qse"],
  audit_read: ["admin", "administrateur", "directeur", "qualit", "quality", "qse"],
};

export function roleHasSurfaceFinishCapability(
  role: string | null | undefined,
  capability: SurfaceFinishCapability
): boolean {
  if (hasGrantedAccountModuleAccess()) return true;
  const normalized = (role ?? "").trim().toLowerCase();
  if (!normalized) return false;
  const needles = CAPABILITY_NEEDLES[capability];
  if (!needles) return false;
  return needles.some((needle) => normalized.includes(needle));
}

export function assertSurfaceFinishCapability(
  role: string | null | undefined,
  capability: SurfaceFinishCapability
): void {
  if (!roleHasSurfaceFinishCapability(role, capability)) {
    throw new HttpError(
      403,
      "SURFACE_FINISH_CAPABILITY_REQUIRED",
      `La capacité Finitions '${capability}' est requise.`
    );
  }
}

export function surfaceFinishCapabilitiesFor(
  role: string | null | undefined
): Record<SurfaceFinishCapability, boolean> {
  const out = {} as Record<SurfaceFinishCapability, boolean>;
  for (const capability of SURFACE_FINISH_CAPABILITIES) {
    out[capability] = roleHasSurfaceFinishCapability(role, capability);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* 2) Cycle de vie — finitions et révisions                                   */
/* -------------------------------------------------------------------------- */

export const SURFACE_FINISH_STATUSES = [
  "BROUILLON",
  "EN_VALIDATION",
  "ACTIVE",
  "SUSPENDUE",
  "OBSOLETE",
  "ARCHIVEE",
] as const;
export type SurfaceFinishStatus = (typeof SURFACE_FINISH_STATUSES)[number];

const STATUS_TRANSITIONS: Readonly<Record<SurfaceFinishStatus, readonly SurfaceFinishStatus[]>> = {
  BROUILLON: ["EN_VALIDATION", "ARCHIVEE"],
  EN_VALIDATION: ["ACTIVE", "BROUILLON", "ARCHIVEE"],
  // Une révision active ne redevient jamais un brouillon : on la suspend, on la
  // rend obsolète, ou on publie une nouvelle révision.
  ACTIVE: ["SUSPENDUE", "OBSOLETE"],
  SUSPENDUE: ["ACTIVE", "OBSOLETE"],
  OBSOLETE: ["ARCHIVEE"],
  ARCHIVEE: [],
};

export function assertSurfaceFinishTransition(from: SurfaceFinishStatus, to: SurfaceFinishStatus): void {
  if (from === to) {
    throw new HttpError(
      409,
      "SURFACE_FINISH_TRANSITION_NOOP",
      `La finition est déjà dans l'état ${from}.`
    );
  }
  if (!STATUS_TRANSITIONS[from]?.includes(to)) {
    throw new HttpError(
      409,
      "SURFACE_FINISH_TRANSITION_FORBIDDEN",
      `Transition de finition interdite : ${from} vers ${to}.`
    );
  }
}

/** Seule une révision ACTIVE peut être posée sur une nouvelle gamme. */
export function assertRevisionSelectable(status: SurfaceFinishStatus): void {
  if (status !== "ACTIVE") {
    throw new HttpError(
      409,
      "FINISH_REVISION_INACTIVE",
      "Seule une révision de finition active peut être appliquée à une gamme."
    );
  }
}

/** Le contenu technique d'une révision publiée est figé : on crée une révision. */
export function assertRevisionContentMutable(status: SurfaceFinishStatus): void {
  if (status !== "BROUILLON" && status !== "EN_VALIDATION") {
    throw new HttpError(
      409,
      "SURFACE_FINISH_REVISION_IMMUTABLE",
      "Une révision publiée est figée : créez une nouvelle révision."
    );
  }
}

/** Les statuts qui restent lisibles dans l'historique mais ne se choisissent plus. */
export function statusIsHistoricalOnly(status: SurfaceFinishStatus): boolean {
  return status === "SUSPENDUE" || status === "OBSOLETE" || status === "ARCHIVEE";
}

/* -------------------------------------------------------------------------- */
/* 2 bis) Archivage d'une FINITION (#226)                                     */
/* -------------------------------------------------------------------------- */
//
// `STATUS_TRANSITIONS` ci-dessus gouverne les RÉVISIONS. Archiver la finition
// elle-même est un autre acte : on sort une entrée du référentiel sans toucher
// à ce que les gammes ont déjà figé. Les deux ne se confondent pas.

/** Une finition déjà archivée ne se réarchive pas ; le motif est obligatoire. */
export function assertFinishArchivable(status: SurfaceFinishStatus): void {
  if (status === "ARCHIVEE") {
    throw new HttpError(409, "SURFACE_FINISH_ALREADY_ARCHIVED", "Cette finition est déjà archivée.");
  }
}

export function assertFinishReactivable(status: SurfaceFinishStatus): void {
  if (status !== "ARCHIVEE") {
    throw new HttpError(
      409,
      "SURFACE_FINISH_NOT_ARCHIVED",
      "Cette finition n'est pas archivée : il n'y a rien à réactiver."
    );
  }
}

/**
 * Statut retrouvé en sortie d'archive. On ne restaure PAS le statut d'avant :
 * il n'a pas été conservé et le déduire d'une colonne effacée serait une
 * invention. On le recalcule depuis la seule chose qui fasse foi — les
 * révisions existantes.
 */
export function statusAfterReactivation(hasActiveRevision: boolean): SurfaceFinishStatus {
  return hasActiveRevision ? "ACTIVE" : "BROUILLON";
}

/* -------------------------------------------------------------------------- */
/* 2 ter) Similarité — contrôle des doublons du RÉFÉRENTIEL (#226)            */
/* -------------------------------------------------------------------------- */
//
// La base interdit le doublon STRICT (index `surface_finishes_identity_uq` :
// même famille + même procédé + même désignation, normalisés). Elle ne peut pas
// arbitrer « anodisation noire » contre « anodisation noire mate » : seul le
// métier le peut. D'où un service CONSULTATIF, jamais bloquant.

export const SIMILARITY_LEVELS = ["IDENTIQUE", "TRES_PROCHE", "PROCHE"] as const;
export type SimilarityLevel = (typeof SIMILARITY_LEVELS)[number];

/** En deçà, deux libellés n'ont plus rien à voir : ne pas encombrer l'écran. */
export const SIMILARITY_FLOOR = 0.34;
const VERY_CLOSE_FLOOR = 0.62;

/**
 * `exactIdentity` vient de la base (le triplet normalisé), pas du score : deux
 * libellés identiques à la casse près SONT le même, quel que soit le trigramme.
 */
export function classifySimilarity(score: number, exactIdentity: boolean): SimilarityLevel | null {
  if (exactIdentity) return "IDENTIQUE";
  if (!Number.isFinite(score) || score < SIMILARITY_FLOOR) return null;
  return score >= VERY_CLOSE_FLOOR ? "TRES_PROCHE" : "PROCHE";
}

export const SIMILARITY_LEVEL_LABELS: Record<SimilarityLevel, string> = {
  IDENTIQUE: "Doublon : cette finition existe déjà",
  TRES_PROCHE: "Très proche — vérifiez avant de créer",
  PROCHE: "Proche — peut-être la même prestation",
};

/** Motif d'archivage : assez long pour dire pourquoi, pas un simple « ok ». */
export const ARCHIVE_REASON_MIN_LENGTH = 10;

/* -------------------------------------------------------------------------- */
/* 3) Gammes — modifiabilité                                                  */
/* -------------------------------------------------------------------------- */

export const EDITABLE_GAMME_STATUSES = ["BROUILLON", "EN_VALIDATION"] as const;

/**
 * Une gamme APPLICABLE ou OBSOLETE n'est jamais modifiée silencieusement : la
 * finition d'une gamme déjà applicable se remplace en créant une nouvelle
 * gamme/version, pas en réécrivant l'historique.
 */
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

export function assertOperationIsSubcontracting(typeOperation: string | null | undefined): void {
  if ((typeOperation ?? "").trim().toUpperCase() !== "SOUS_TRAITANCE") {
    throw new HttpError(
      422,
      "OPERATION_NOT_SUBCONTRACTING",
      "Seule une opération de type Sous-traitance porte une finition."
    );
  }
}

export function assertOperationBelongsToGamme(operationGammeId: string | null | undefined, gammeId: string): void {
  if (!operationGammeId || operationGammeId !== gammeId) {
    throw new HttpError(
      409,
      "OPERATION_GAMME_MISMATCH",
      "Cette opération n'appartient pas à la gamme indiquée."
    );
  }
}

/* -------------------------------------------------------------------------- */
/* 4) Normalisation des unités et des valeurs                                 */
/* -------------------------------------------------------------------------- */

export const THICKNESS_UNITS = ["um", "mm", "cm", "in", "mil"] as const;
export type ThicknessUnit = (typeof THICKNESS_UNITS)[number];

// Facteurs vers le micromètre, unité pivot des épaisseurs de revêtement.
const THICKNESS_TO_MICROMETER: Record<ThicknessUnit, number> = {
  um: 1,
  mm: 1000,
  cm: 10000,
  in: 25400,
  mil: 25.4,
};

const THICKNESS_ALIASES: Record<string, ThicknessUnit> = {
  um: "um",
  µm: "um",
  μm: "um",
  micron: "um",
  microns: "um",
  micrometre: "um",
  micrometres: "um",
  mm: "mm",
  millimetre: "mm",
  millimetres: "mm",
  cm: "cm",
  centimetre: "cm",
  centimetres: "cm",
  in: "in",
  inch: "in",
  inches: "in",
  pouce: "in",
  mil: "mil",
  mils: "mil",
  thou: "mil",
};

function stripDiacritics(value: string): string {
  return value.normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

export function normalizeThicknessUnit(value: string | null | undefined): ThicknessUnit {
  const raw = stripDiacritics((value ?? "").trim().toLowerCase()).replace(/[.\s]/g, "");
  const direct = THICKNESS_ALIASES[(value ?? "").trim().toLowerCase()] ?? THICKNESS_ALIASES[raw];
  if (!direct) {
    throw new HttpError(
      422,
      "SURFACE_FINISH_THICKNESS_UNIT_INVALID",
      `Unité d'épaisseur inconnue : ${String(value ?? "")}.`
    );
  }
  return direct;
}

/** Arrondi stable à 6 décimales : élimine le bruit binaire de la conversion. */
function roundStable(value: number, decimals = 6): number {
  const factor = 10 ** decimals;
  const rounded = Math.round(value * factor) / factor;
  // -0 et 0 doivent produire la même empreinte.
  return Object.is(rounded, -0) ? 0 : rounded;
}

export function thicknessToMicrometers(value: number | null | undefined, unit: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value)) {
    throw new HttpError(422, "SURFACE_FINISH_THICKNESS_INVALID", "Épaisseur non numérique.");
  }
  if (value < 0) {
    throw new HttpError(422, "SURFACE_FINISH_THICKNESS_INVALID", "Une épaisseur ne peut pas être négative.");
  }
  return roundStable(value * THICKNESS_TO_MICROMETER[normalizeThicknessUnit(unit)], 4);
}

export type ThicknessRange = {
  min_um: number | null;
  nominal_um: number | null;
  max_um: number | null;
};

export function assertThicknessCoherent(range: ThicknessRange): void {
  const { min_um, nominal_um, max_um } = range;
  if (min_um !== null && max_um !== null && min_um > max_um) {
    throw new HttpError(
      422,
      "SURFACE_FINISH_THICKNESS_RANGE_INVALID",
      "L'épaisseur minimale dépasse l'épaisseur maximale."
    );
  }
  if (nominal_um !== null && min_um !== null && nominal_um < min_um) {
    throw new HttpError(
      422,
      "SURFACE_FINISH_THICKNESS_RANGE_INVALID",
      "L'épaisseur nominale est inférieure à l'épaisseur minimale."
    );
  }
  if (nominal_um !== null && max_um !== null && nominal_um > max_um) {
    throw new HttpError(
      422,
      "SURFACE_FINISH_THICKNESS_RANGE_INVALID",
      "L'épaisseur nominale dépasse l'épaisseur maximale."
    );
  }
}

/**
 * Texte canonique : accents conservés (le métier lit du français), casse et
 * espaces normalisés. Une chaîne vide devient `null` pour que « champ absent »
 * et « champ vide » produisent la MÊME empreinte.
 */
export function canonicalText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const collapsed = String(value).replace(/\s+/g, " ").trim();
  return collapsed === "" ? null : collapsed;
}

/** Identifiant fonctionnel : casse et accents neutralisés (norme, RAL, classe…). */
export function canonicalToken(value: string | null | undefined): string | null {
  const text = canonicalText(value);
  if (text === null) return null;
  return stripDiacritics(text).toUpperCase().replace(/\s+/g, " ");
}

/** Liste canonique : tokens normalisés, dédoublonnés, triés — l'ordre de saisie ne compte pas. */
export function canonicalTokenList(values: readonly (string | null | undefined)[] | null | undefined): string[] {
  if (!values) return [];
  const set = new Set<string>();
  for (const value of values) {
    const token = canonicalToken(value);
    if (token) set.add(token);
  }
  return [...set].sort((left, right) => left.localeCompare(right, "fr"));
}

export function canonicalNumber(value: number | null | undefined, decimals = 4): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value)) {
    throw new HttpError(422, "SURFACE_FINISH_NUMBER_INVALID", "Valeur numérique invalide.");
  }
  return roundStable(value, decimals);
}

/* -------------------------------------------------------------------------- */
/* 5) Spécification canonique et empreinte                                    */
/* -------------------------------------------------------------------------- */

export const FINISH_SCOPES = ["PIECE_ENTIERE", "ZONES", "AUTRE"] as const;
export type FinishScope = (typeof FINISH_SCOPES)[number];

/** Entrée brute de la spécification, telle que résolue par le serveur. */
export type SurfaceFinishSpecInput = {
  piece_technique_version_id: string;
  finish_revision_id: string;
  norme: string | null;
  classe: string | null;
  perimetre: FinishScope;
  zones: readonly string[] | null;
  masquages: readonly string[] | null;
  epaisseur_min: number | null;
  epaisseur_nominale: number | null;
  epaisseur_max: number | null;
  epaisseur_unite: string | null;
  couleur: string | null;
  teinte_ral: string | null;
  aspect: string | null;
  rugosite: string | null;
  durete: string | null;
  exigence_corrosion: string | null;
  pretraitement: string | null;
  posttraitement: string | null;
  controles: readonly string[] | null;
  certificat_requis: boolean;
  certificat_type: string | null;
  conditionnement: string | null;
  unite_achat: string | null;
  specification_client: string | null;
  specification_client_version: string | null;
  instructions: string | null;
};

/**
 * Spécification canonique — l'objet EXACT dont on prend l'empreinte.
 *
 * Sont volontairement absents : fournisseur, prix, devise, MOQ, multiple,
 * délai, date de besoin, quantité commandée et tout commentaire commercial.
 * Ces données appartiennent au catalogue fournisseur et à la commande, jamais
 * à l'identité technique de la prestation.
 *
 * `instructions` EST retenu (écart assumé et documenté vis-à-vis d'une lecture
 * minimale) : ce texte part chez le sous-traitant et figure dans le commentaire
 * de l'article. L'exclure permettrait de réutiliser un article dont le
 * commentaire contredirait l'opération qui le réutilise. L'inclure ne peut que
 * créer des articles plus distincts, jamais en fusionner deux différents.
 */
export type CanonicalFinishSpec = {
  schema_version: 1;
  piece_technique_version_id: string;
  finish_revision_id: string;
  norme: string | null;
  classe: string | null;
  perimetre: FinishScope;
  zones: string[];
  masquages: string[];
  epaisseur_min_um: number | null;
  epaisseur_nominale_um: number | null;
  epaisseur_max_um: number | null;
  epaisseur_unite_canonique: "um";
  couleur: string | null;
  teinte_ral: string | null;
  aspect: string | null;
  rugosite: string | null;
  durete: string | null;
  exigence_corrosion: string | null;
  pretraitement: string | null;
  posttraitement: string | null;
  controles: string[];
  certificat_requis: boolean;
  certificat_type: string | null;
  conditionnement: string | null;
  unite_achat: string;
  specification_client: string | null;
  specification_client_version: string | null;
  instructions: string | null;
};

export const DEFAULT_PURCHASE_UNIT = "PCE";

export function buildCanonicalFinishSpec(input: SurfaceFinishSpecInput): CanonicalFinishSpec {
  const unite = normalizeThicknessUnit(input.epaisseur_unite ?? "um");
  const range: ThicknessRange = {
    min_um: thicknessToMicrometers(input.epaisseur_min, unite),
    nominal_um: thicknessToMicrometers(input.epaisseur_nominale, unite),
    max_um: thicknessToMicrometers(input.epaisseur_max, unite),
  };
  assertThicknessCoherent(range);

  const perimetre = input.perimetre;
  const zones = canonicalTokenList(input.zones);
  if (perimetre === "ZONES" && zones.length === 0) {
    throw new HttpError(
      422,
      "SURFACE_FINISH_ZONES_REQUIRED",
      "Un périmètre « zones » exige au moins une zone traitée."
    );
  }

  return {
    schema_version: 1,
    piece_technique_version_id: input.piece_technique_version_id,
    finish_revision_id: input.finish_revision_id,
    norme: canonicalToken(input.norme),
    classe: canonicalToken(input.classe),
    perimetre,
    // Un périmètre « pièce entière » ignore les zones : deux saisies qui
    // décrivent la même prestation doivent produire la même empreinte.
    zones: perimetre === "PIECE_ENTIERE" ? [] : zones,
    masquages: canonicalTokenList(input.masquages),
    epaisseur_min_um: range.min_um,
    epaisseur_nominale_um: range.nominal_um,
    epaisseur_max_um: range.max_um,
    epaisseur_unite_canonique: "um",
    couleur: canonicalToken(input.couleur),
    teinte_ral: canonicalRal(input.teinte_ral),
    aspect: canonicalToken(input.aspect),
    rugosite: canonicalToken(input.rugosite),
    durete: canonicalToken(input.durete),
    exigence_corrosion: canonicalToken(input.exigence_corrosion),
    pretraitement: canonicalToken(input.pretraitement),
    posttraitement: canonicalToken(input.posttraitement),
    controles: canonicalTokenList(input.controles),
    certificat_requis: Boolean(input.certificat_requis),
    certificat_type: input.certificat_requis ? canonicalToken(input.certificat_type) : null,
    conditionnement: canonicalToken(input.conditionnement),
    unite_achat: canonicalToken(input.unite_achat) ?? DEFAULT_PURCHASE_UNIT,
    specification_client: canonicalToken(input.specification_client),
    specification_client_version: canonicalToken(input.specification_client_version),
    instructions: canonicalText(input.instructions),
  };
}

/** RAL canonique : « ral 9005 », « RAL9005 », « Ral-9005 » → « RAL 9005 ». */
export function canonicalRal(value: string | null | undefined): string | null {
  const token = canonicalToken(value);
  if (token === null) return null;
  const match = /^RAL[\s-]*([0-9]{4})$/.exec(token.replace(/\s+/g, " "));
  return match ? `RAL ${match[1]}` : token;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, child]) => [key, canonicalize(child)])
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function sha256Hex(value: unknown): string {
  return crypto.createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/** Empreinte fonctionnelle de la prestation. Deux articles identiques ⇒ même valeur. */
export function computeSpecFingerprint(spec: CanonicalFinishSpec): string {
  return sha256Hex(spec);
}

/** Champs comparés pour expliquer une différence entre deux spécifications. */
export function diffCanonicalSpecs(
  left: CanonicalFinishSpec,
  right: CanonicalFinishSpec
): Array<{ field: keyof CanonicalFinishSpec; left: unknown; right: unknown }> {
  const out: Array<{ field: keyof CanonicalFinishSpec; left: unknown; right: unknown }> = [];
  const keys = Object.keys(left) as Array<keyof CanonicalFinishSpec>;
  for (const key of keys) {
    if (key === "schema_version") continue;
    const a = canonicalJson(left[key]);
    const b = canonicalJson(right[key]);
    if (a !== b) out.push({ field: key, left: left[key], right: right[key] });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* 6) Génération de la désignation                                            */
/* -------------------------------------------------------------------------- */

// Le schéma Article limite la désignation ; on reste large sous la limite pour
// que la troncature soit lisible plutôt que brutale.
export const DESIGNATION_MAX_LENGTH = 180;
export const COMMENT_MAX_LENGTH = 4000;
export const GENERATION_TEMPLATE_VERSION = 1;

export type DesignationContext = {
  code_piece: string;
  indice: string;
  finition_courte: string;
  teinte_ral: string | null;
  couleur: string | null;
  epaisseur_nominale_um: number | null;
  epaisseur_min_um: number | null;
  classe: string | null;
  perimetre: FinishScope;
  zones: readonly string[];
};

function formatMicrometers(value: number | null): string | null {
  if (value === null) return null;
  const rounded = Math.round(value * 100) / 100;
  const text = Number.isInteger(rounded) ? String(rounded) : String(rounded).replace(".", ",");
  return `${text} µm`;
}

/**
 * `ST — {code_piece} ind. {indice} — {finition_courte}` enrichi des seuls
 * qualificatifs DISCRIMINANTS réellement disponibles (teinte, épaisseur, classe,
 * zone). Aucun `null`, aucun `undefined`, aucun UUID, aucun séparateur vide.
 */
export function buildGeneratedDesignation(ctx: DesignationContext): string {
  const codePiece = canonicalText(ctx.code_piece);
  const indice = canonicalText(ctx.indice);
  const finition = canonicalText(ctx.finition_courte);
  const missing: string[] = [];
  if (!codePiece) missing.push("code_piece");
  if (!indice) missing.push("indice");
  if (!finition) missing.push("finition_courte");
  if (missing.length > 0) {
    throw new HttpError(
      422,
      "SURFACE_FINISH_DESIGNATION_CONTEXT_INCOMPLETE",
      "Impossible de générer la désignation : contexte incomplet.",
      { missing }
    );
  }

  const qualifiers: string[] = [];
  const teinte = canonicalRal(ctx.teinte_ral) ?? canonicalText(ctx.couleur);
  if (teinte) qualifiers.push(teinte);
  const epaisseur = formatMicrometers(ctx.epaisseur_nominale_um ?? ctx.epaisseur_min_um);
  if (epaisseur) qualifiers.push(epaisseur);
  const classe = canonicalText(ctx.classe);
  if (classe) qualifiers.push(`cl. ${classe}`);
  if (ctx.perimetre === "ZONES" && ctx.zones.length > 0) {
    qualifiers.push(ctx.zones.length === 1 ? `zone ${ctx.zones[0]}` : `${ctx.zones.length} zones`);
  }

  const tail = qualifiers.length > 0 ? `${finition} ${qualifiers.join(" ")}` : (finition as string);
  const full = `ST — ${codePiece} ind. ${indice} — ${tail}`;
  return truncateReadable(full, DESIGNATION_MAX_LENGTH);
}

/** Troncature qui ne coupe jamais au milieu d'un mot si l'on peut l'éviter. */
export function truncateReadable(value: string, max: number): string {
  if (value.length <= max) return value;
  const hard = value.slice(0, max - 1);
  const lastSpace = hard.lastIndexOf(" ");
  const base = lastSpace > max * 0.6 ? hard.slice(0, lastSpace) : hard;
  return `${base.trimEnd()}…`;
}

/* -------------------------------------------------------------------------- */
/* 7) Génération du commentaire technique                                     */
/* -------------------------------------------------------------------------- */

/**
 * Liste blanche EXHAUSTIVE des variables interpolables. Toute variable absente
 * de cette liste fait échouer le rendu : un modèle ne peut pas exfiltrer un
 * champ arbitraire, ni du contexte serveur.
 */
export const COMMENT_TEMPLATE_VARIABLES = [
  "gamme_code",
  "code_piece",
  "designation_piece",
  "indice",
  "plan_reference",
  "numero_operation",
  "designation_operation",
  "code_finition",
  "designation_finition",
  "revision_finition",
  "norme",
  "epaisseur",
  "teinte_aspect",
  "perimetre",
  "zones_masquages",
  "certificat",
  "controles",
  "conditionnement",
  "instructions",
] as const;
export type CommentTemplateVariable = (typeof COMMENT_TEMPLATE_VARIABLES)[number];

export const DEFAULT_COMMENT_TEMPLATE = [
  "Sous-traitance issue de la gamme {gamme_code}.",
  "Pièce : {code_piece} — {designation_piece}",
  "Indice : {indice}",
  "Plan : {plan_reference}",
  "Opération : {numero_operation} — {designation_operation}",
  "Finition : {code_finition} — {designation_finition}",
  "Révision de finition : {revision_finition}",
  "Norme / spécification : {norme}",
  "Épaisseur : {epaisseur}",
  "Teinte / aspect : {teinte_aspect}",
  "Périmètre traité : {perimetre}",
  "Zones et masquages : {zones_masquages}",
  "Certificat requis : {certificat}",
  "Contrôles requis : {controles}",
  "Conditionnement retour : {conditionnement}",
  "Instructions complémentaires : {instructions}",
].join("\n");

const TEMPLATE_TOKEN = /\{([a-z_]+)\}/g;

export function assertTemplateVariablesAllowed(template: string): void {
  const unknown = new Set<string>();
  for (const match of template.matchAll(TEMPLATE_TOKEN)) {
    const name = match[1];
    if (!(COMMENT_TEMPLATE_VARIABLES as readonly string[]).includes(name)) unknown.add(name);
  }
  if (unknown.size > 0) {
    throw new HttpError(
      422,
      "SURFACE_FINISH_TEMPLATE_VARIABLE_FORBIDDEN",
      "Le modèle utilise une variable non autorisée.",
      { forbidden: [...unknown].sort() }
    );
  }
}

/**
 * Neutralise ce qui pourrait transformer une valeur métier en balise, en
 * modèle imbriqué, ou en injection de ligne. On n'échappe pas « en HTML » :
 * le commentaire est un texte, il ne doit contenir ni `<`, ni `>`, ni accolade,
 * ni retour chariot non maîtrisé.
 */
export function sanitizeTemplateValue(value: unknown, maxLength = 400): string {
  if (value === null || value === undefined) return "";
  const raw = Array.isArray(value) ? value.filter(Boolean).join(", ") : String(value);
  const cleaned = raw
    // Caracteres de controle : jamais dans un texte metier.
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, " ")
    .replace(/[<>{}]/g, " ")
    .replace(/\r?\n/g, " · ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > maxLength ? truncateReadable(cleaned, maxLength) : cleaned;
}

export type CommentRenderResult = {
  text: string;
  template_version: number;
  omitted_lines: string[];
};

/**
 * Rendu du commentaire : une ligne dont TOUTES les variables sont vides est
 * supprimée proprement. Jamais de `null`, jamais de `undefined`, jamais un
 * libellé suivi d'un séparateur vide.
 */
export function renderGeneratedComment(
  template: string,
  values: Partial<Record<CommentTemplateVariable, unknown>>,
  templateVersion = GENERATION_TEMPLATE_VERSION
): CommentRenderResult {
  assertTemplateVariablesAllowed(template);

  const omitted: string[] = [];
  const lines: string[] = [];

  for (const line of template.split("\n")) {
    const tokens = [...line.matchAll(TEMPLATE_TOKEN)].map((match) => match[1] as CommentTemplateVariable);
    if (tokens.length === 0) {
      if (line.trim() !== "") lines.push(line.trim());
      continue;
    }
    const rendered = line.replace(TEMPLATE_TOKEN, (_full, name: string) =>
      sanitizeTemplateValue(values[name as CommentTemplateVariable])
    );
    const allEmpty = tokens.every((token) => sanitizeTemplateValue(values[token]) === "");
    if (allEmpty) {
      omitted.push(line.trim());
      continue;
    }
    const collapsed = rendered.replace(/[ \t]+/g, " ").trim();
    // Une ligne réduite à son libellé et son séparateur n'apporte rien.
    if (collapsed === "" || /^[^:]*:\s*$/.test(collapsed) || /^[-—·,;]+$/.test(collapsed)) {
      omitted.push(line.trim());
      continue;
    }
    lines.push(collapsed);
  }

  const text = truncateReadable(lines.join("\n"), COMMENT_MAX_LENGTH);
  return { text, template_version: templateVersion, omitted_lines: omitted };
}

/**
 * Un override d'un texte généré exige une capacité dédiée ET un motif écrit.
 * L'avant/après est journalisé par l'appelant.
 */
export function assertGeneratedTextOverrideAllowed(params: {
  role: string | null | undefined;
  reason: string | null | undefined;
}): void {
  if (!roleHasSurfaceFinishCapability(params.role, "generated_text_override")) {
    throw new HttpError(
      403,
      "SURFACE_FINISH_OVERRIDE_FORBIDDEN",
      "Modifier un texte généré exige la capacité 'generated_text_override'."
    );
  }
  if ((params.reason ?? "").trim().length < 15) {
    throw new HttpError(
      422,
      "SURFACE_FINISH_OVERRIDE_REASON_REQUIRED",
      "Un texte généré ne se remplace qu'avec un motif d'au moins 15 caractères."
    );
  }
}

/* -------------------------------------------------------------------------- */
/* 8) Décision de résolution d'article                                        */
/* -------------------------------------------------------------------------- */

export const ARTICLE_DECISIONS = ["REUSE", "CREATE", "FORCE_CREATE"] as const;
export type ArticleDecision = (typeof ARTICLE_DECISIONS)[number];

export type ResolutionState = {
  exactMatchArticleId: string | null;
  exactMatchIsActive: boolean;
};

/**
 * Arbitrage serveur de la décision demandée par l'interface. L'UI propose ;
 * le serveur dispose. Aucune fusion n'est faite sur un nom : seule l'empreinte
 * fait foi, et elle a été recalculée juste avant.
 */
export function assertArticleDecisionConsistent(params: {
  decision: ArticleDecision;
  state: ResolutionState;
  requestedArticleId: string | null;
  role: string | null | undefined;
  justification: string | null;
}): void {
  const { decision, state, requestedArticleId } = params;

  if (decision === "REUSE") {
    if (!state.exactMatchArticleId) {
      throw new HttpError(
        409,
        "ARTICLE_EXACT_MATCH_CHANGED",
        "Aucun article exact ne correspond plus à cette spécification : rechargez l'aperçu."
      );
    }
    if (!requestedArticleId || requestedArticleId !== state.exactMatchArticleId) {
      throw new HttpError(
        409,
        "ARTICLE_EXACT_MATCH_CHANGED",
        "L'article exact a changé depuis l'aperçu : rechargez avant de confirmer."
      );
    }
    if (!state.exactMatchIsActive) {
      throw new HttpError(
        422,
        "ARTICLE_SPEC_CONFLICT",
        "L'article exact est inactif : réactivez-le ou créez un article distinct."
      );
    }
    return;
  }

  if (decision === "CREATE") {
    if (state.exactMatchArticleId) {
      throw new HttpError(
        409,
        "ARTICLE_SPEC_CONFLICT",
        "Un article exact existe déjà : réutilisez-le, ou demandez explicitement un article distinct."
      );
    }
    return;
  }

  // FORCE_CREATE
  if (!roleHasSurfaceFinishCapability(params.role, "article_force_create")) {
    throw new HttpError(
      403,
      "ARTICLE_FORCE_CREATE_FORBIDDEN",
      "Créer un article distinct alors qu'un article compatible existe exige une habilitation dédiée."
    );
  }
  if ((params.justification ?? "").trim().length < 20) {
    throw new HttpError(
      422,
      "ARTICLE_FORCE_CREATE_JUSTIFICATION_REQUIRED",
      "Un article distinct exige une justification écrite d'au moins 20 caractères."
    );
  }
}

/* -------------------------------------------------------------------------- */
/* 9) Aperçu, idempotence et verrou optimiste                                 */
/* -------------------------------------------------------------------------- */

/**
 * Empreinte de l'aperçu : elle couvre le contexte ET le résultat proposé, pour
 * qu'un changement d'article exact, de gamme ou de révision périme l'aperçu.
 */
export function computePreviewHash(params: {
  gamme_id: string;
  operation_id: string;
  spec_fingerprint: string;
  exact_match_article_id: string | null;
  designation: string;
  comment: string;
  gamme_updated_at: string;
  operation_updated_at: string | null;
}): string {
  return sha256Hex({
    kind: "surface_finish_preview",
    version: 1,
    ...params,
  });
}

export function assertPreviewFresh(expected: string | null | undefined, current: string): void {
  const value = (expected ?? "").trim();
  if (!value) {
    throw new HttpError(
      422,
      "PREVIEW_REQUIRED",
      "Un aperçu serveur est obligatoire avant de confirmer."
    );
  }
  if (value !== current) {
    throw new HttpError(
      409,
      "PREVIEW_STALE",
      "L'aperçu n'est plus à jour : rechargez-le avant de confirmer."
    );
  }
}

export function normalizeIdempotencyKey(value: string | null | undefined): string {
  const normalized = (value ?? "").trim();
  if (normalized.length < 8 || normalized.length > 200) {
    throw new HttpError(
      400,
      "IDEMPOTENCY_KEY_INVALID",
      "Idempotency-Key doit contenir entre 8 et 200 caractères."
    );
  }
  return normalized;
}

export function requestHash(commandType: string, payload: unknown): string {
  return sha256Hex({ command_type: commandType, payload });
}

export function decideReceipt(
  existingHash: string | null | undefined,
  incomingHash: string
): "NEW" | "REPLAY" | "CONFLICT" {
  if (!existingHash) return "NEW";
  return existingHash === incomingHash ? "REPLAY" : "CONFLICT";
}

export function assertNoIdempotencyConflict(decision: "NEW" | "REPLAY" | "CONFLICT"): void {
  if (decision === "CONFLICT") {
    throw new HttpError(
      409,
      "IDEMPOTENCY_CONFLICT",
      "Cette clé d'idempotence a déjà servi pour une autre demande."
    );
  }
}

export function assertOptimisticVersion(params: {
  expectedUpdatedAt: string | null | undefined;
  currentUpdatedAt: string | Date;
  label: string;
}): void {
  const expected = (params.expectedUpdatedAt ?? "").trim();
  if (!expected) {
    throw new HttpError(
      422,
      "EXPECTED_VERSION_REQUIRED",
      `expected_updated_at est obligatoire pour modifier ${params.label}.`
    );
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

/* -------------------------------------------------------------------------- */
/* 10) Taxonomie de l'article généré — la CAT est une donnée, pas un enum     */
/* -------------------------------------------------------------------------- */

/**
 * Arbitrage CAT (#210) : la catégorie MÉTIER de l'article généré est
 * `traitement_surface`. La catégorie technique reste `traitement` et le type
 * reste `PURCHASED` : l'article représente une prestation approvisionnée.
 *
 * La CAT `sous_traitance` n'est PAS ajoutée : le multi-classement l'autoriserait
 * (la catégorie primaire resterait `traitement`, cf. la table de priorité du
 * module Stock), mais elle diluerait le filtre « Traitement de surface » des
 * écrans Articles sans rien apporter. Décision documentée dans l'ADR-0038.
 */
export const GENERATED_ARTICLE_TAXONOMY = {
  article_type: "PURCHASED",
  article_category: "traitement",
  article_categories: ["traitement_surface"],
  default_family_code: "TRT",
  stock_managed: false,
  lot_tracking: false,
} as const;

export const PURCHASE_LINE_TYPE = "TRAITEMENT" as const;

/**
 * Catégorie de ligne du catalogue fournisseur. L'enum du catalogue accepte
 * `SOUS_TRAITANCE` mais pas `TRAITEMENT` : on ne modifie pas cet enum ici, on
 * documente le mapping et on l'expose pour que l'UI dise la vérité.
 */
export const SUPPLIER_CATALOGUE_CATEGORY = "SOUS_TRAITANCE" as const;
import { hasGrantedAccountModuleAccess } from "../../access-control/context/account-module-access.context";
