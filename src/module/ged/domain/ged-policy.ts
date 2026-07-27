// GED centrale CERP (ADR-0037) — politiques pures, sans I/O.
//
// Ce fichier concentre les règles qui ne doivent jamais dépendre d'un appel
// réseau, d'un client SQL ou du système de fichiers : capacités RBAC, cycle de
// vie documentaire, séparation des tâches, codification.
//
// Même mécanique de « needles » que `quality-policy.ts` et `of-rbac.ts` : les
// rôles CERP sont du texte libre en base, on ne crée pas une seconde
// nomenclature de rôles en parallèle.

import { HttpError } from "../../../utils/httpError";

/* -------------------------------------------------------------------------- */
/* 1) Capacités RBAC — refus par défaut                                       */
/* -------------------------------------------------------------------------- */

export const GED_CAPABILITIES = [
  "read",
  "upload",
  "update_metadata",
  "checkout",
  "checkin",
  "submit",
  "approve",
  "publish",
  "obsolete",
  "download",
  "export",
  "admin",
] as const;

export type GedCapability = (typeof GED_CAPABILITIES)[number];

const CAPABILITY_NEEDLES: Record<GedCapability, readonly string[]> = {
  read: [
    "admin", "administrateur", "directeur", "qualit", "quality", "qse",
    "method", "technique", "bureau", "production", "atelier", "programm",
    "achat", "commerc", "logisti", "magasin", "metrolog", "compta",
  ],
  upload: [
    "admin", "administrateur", "directeur", "qualit", "quality", "qse",
    "method", "technique", "bureau", "programm", "achat", "commerc",
    "logisti", "magasin", "metrolog", "compta",
  ],
  update_metadata: [
    "admin", "administrateur", "directeur", "qualit", "quality", "qse",
    "method", "technique", "bureau", "programm", "achat", "commerc", "metrolog",
  ],
  checkout: ["admin", "administrateur", "directeur", "method", "technique", "bureau", "programm"],
  checkin: ["admin", "administrateur", "directeur", "method", "technique", "bureau", "programm"],
  submit: [
    "admin", "administrateur", "directeur", "qualit", "quality", "qse",
    "method", "technique", "bureau", "programm", "achat", "commerc", "metrolog", "compta",
  ],
  // Approuver et publier restent volontairement étroits : ce sont les deux
  // gestes qui rendent un document opposable à l'atelier et au client.
  approve: ["admin", "administrateur", "directeur", "qualit", "quality", "qse", "responsable"],
  publish: ["admin", "administrateur", "directeur", "qualit", "quality", "qse", "responsable"],
  obsolete: ["admin", "administrateur", "directeur", "qualit", "quality", "qse", "responsable"],
  download: [
    "admin", "administrateur", "directeur", "qualit", "quality", "qse",
    "method", "technique", "bureau", "production", "atelier", "programm",
    "achat", "commerc", "logisti", "magasin", "metrolog", "compta",
  ],
  // `export` est distinct de `download` : télécharger une pièce n'autorise pas
  // à extraire un lot entier.
  export: ["admin", "administrateur", "directeur", "qualit", "quality", "qse", "responsable"],
  admin: ["admin", "administrateur", "directeur"],
};

export function roleHasGedCapability(
  role: string | null | undefined,
  capability: GedCapability
): boolean {
  const normalized = (role ?? "").trim().toLowerCase();
  if (!normalized) return false;
  const needles = CAPABILITY_NEEDLES[capability];
  if (!needles) return false;
  return needles.some((needle) => normalized.includes(needle));
}

export function assertGedCapability(
  role: string | null | undefined,
  capability: GedCapability
): void {
  if (!roleHasGedCapability(role, capability)) {
    throw new HttpError(
      403,
      "GED_CAPABILITY_REQUIRED",
      `La capacité GED '${capability}' est requise.`
    );
  }
}

/* -------------------------------------------------------------------------- */
/* 2) Cycle de vie documentaire                                               */
/* -------------------------------------------------------------------------- */

export const GED_VERSION_STATUSES = [
  "BROUILLON",
  "EN_REVUE",
  "APPROUVE",
  "APPLICABLE",
  "OBSOLETE",
] as const;

export type GedVersionStatus = (typeof GED_VERSION_STATUSES)[number];

const VERSION_TRANSITIONS: Readonly<Record<GedVersionStatus, readonly GedVersionStatus[]>> = {
  BROUILLON: ["EN_REVUE", "OBSOLETE"],
  EN_REVUE: ["BROUILLON", "APPROUVE", "OBSOLETE"],
  // Une version approuvée se publie ou s'abandonne : elle ne redevient jamais
  // un brouillon, sinon son contenu deviendrait modifiable après approbation.
  APPROUVE: ["APPLICABLE", "OBSOLETE"],
  APPLICABLE: ["OBSOLETE"],
  OBSOLETE: [],
};

export function assertVersionTransition(from: GedVersionStatus, to: GedVersionStatus): void {
  if (!VERSION_TRANSITIONS[from]?.includes(to)) {
    throw new HttpError(
      409,
      "GED_VERSION_TRANSITION_FORBIDDEN",
      `Transition de version interdite : ${from} vers ${to}.`
    );
  }
}

/** Une version approuvée, applicable ou obsolète est figée en contenu. */
export function isVersionFrozen(status: GedVersionStatus): boolean {
  return status === "APPROUVE" || status === "APPLICABLE" || status === "OBSOLETE";
}

export function assertVersionMutable(status: GedVersionStatus): void {
  if (isVersionFrozen(status)) {
    throw new HttpError(
      409,
      "GED_VERSION_IMMUTABLE",
      "Une version approuvée ou publiée ne se modifie pas : créez une nouvelle version."
    );
  }
}

/* -------------------------------------------------------------------------- */
/* 3) Séparation des tâches                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Le déposant d'une version ne peut pas l'approuver. Rejoué ici en plus du
 * trigger `fn_ged_version_separation_of_duties` : le service donne un message
 * lisible, la base garantit que la règle survit à un script.
 */
export function assertDistinctApprover(
  createdBy: number | null | undefined,
  approverId: number
): void {
  if (createdBy != null && createdBy === approverId) {
    throw new HttpError(
      409,
      "GED_APPROVAL_SELF",
      "Le déposant d'une version ne peut pas l'approuver lui-même."
    );
  }
}

/* -------------------------------------------------------------------------- */
/* 4) Codification documentaire                                               */
/* -------------------------------------------------------------------------- */

const CODE_PREFIX_BY_DOMAIN: Readonly<Record<string, string>> = {
  TECHNIQUE: "DT",
  PRODUCTION: "DP",
  QUALITE: "DQ",
  COMMERCIAL: "DC",
  ACHATS: "DA",
  LOGISTIQUE: "DL",
  FINANCE: "DF",
  GOUVERNANCE: "DG",
};

export function documentCodePrefix(domain: string): string {
  return CODE_PREFIX_BY_DOMAIN[domain.trim().toUpperCase()] ?? "DX";
}

/**
 * Code documentaire immuable, jamais réutilisé. La séquence est portée par la
 * base ; cette fonction ne fait que le formatage, pour rester testable sans I/O.
 */
export function formatDocumentCode(domain: string, sequence: number): string {
  if (!Number.isInteger(sequence) || sequence <= 0) {
    throw new HttpError(500, "GED_CODE_SEQUENCE", "Séquence de code documentaire invalide.");
  }
  return `${documentCodePrefix(domain)}-${String(sequence).padStart(6, "0")}`;
}

/* -------------------------------------------------------------------------- */
/* 5) Assainissement des noms de fichier                                      */
/* -------------------------------------------------------------------------- */

const MIN_PRINTABLE_CODE_POINT = 0x20;
const DEL_CODE_POINT = 0x7f;

/**
 * Le nom d'origine est une DONNÉE, jamais un chemin. Il est conservé pour
 * l'affichage et le `Content-Disposition`, mais ne participe jamais à la
 * construction d'un chemin physique : le coffre adresse par empreinte.
 */
export function sanitizeOriginalName(value: string | null | undefined): string {
  // Ne conserver que le dernier segment : `../../etc/passwd` devient `passwd`.
  const base = (value ?? "").split(/[\\/]/).pop() ?? "";
  // Les caractères de contrôle sont retirés par code point plutôt que par un
  // littéral de regex, qui écrirait de vrais octets de contrôle dans ce fichier.
  const printable = Array.from(base.normalize("NFKD"))
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code >= MIN_PRINTABLE_CODE_POINT && code !== DEL_CODE_POINT;
    })
    .join("");
  const cleaned = printable
    .replace(/[^a-zA-Z0-9 ._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-. ]+|[-. ]+$/g, "")
    .trim();
  const safe = cleaned.length > 0 ? cleaned : "document";
  return safe.length > 180 ? safe.slice(0, 180) : safe;
}

export function fileExtension(name: string): string {
  const match = /\.([a-zA-Z0-9]{1,10})$/.exec(name);
  return match ? `.${match[1].toLowerCase()}` : "";
}
