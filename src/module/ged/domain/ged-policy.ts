import { HttpError } from "../../../utils/httpError";
import { normalizeAssignedRoles } from "../../auth/domain/roles";

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

export type GedRoleBearer = {
  role?: string | null;
  primary_role?: string | null;
  roles?: readonly string[] | null;
};

/**
 * Retourne les rôles réellement attribués. La chaîne effective séparée par
 * `|` n'est jamais interprétée par sous-chaîne.
 */
export function gedRoleKeys(user: GedRoleBearer | null | undefined): string[] {
  if (!user) return [];
  return normalizeAssignedRoles(user.primary_role ?? user.role, user.roles);
}

export function assertGedCapabilityGranted(
  granted: boolean,
  capability: GedCapability
): void {
  if (!granted) {
    throw new HttpError(
      403,
      "GED_CAPABILITY_REQUIRED",
      `La capacité GED '${capability}' est requise.`
    );
  }
}

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

export function formatDocumentCode(domain: string, sequence: number): string {
  if (!Number.isInteger(sequence) || sequence <= 0) {
    throw new HttpError(500, "GED_CODE_SEQUENCE", "Séquence de code documentaire invalide.");
  }
  return `${documentCodePrefix(domain)}-${String(sequence).padStart(6, "0")}`;
}

const MIN_PRINTABLE_CODE_POINT = 0x20;
const DEL_CODE_POINT = 0x7f;

/**
 * Le nom d'origine est une donnée d'affichage et ne participe jamais à la
 * construction du chemin physique dans le coffre.
 */
export function sanitizeOriginalName(value: string | null | undefined): string {
  const base = (value ?? "").split(/[\\/]/).pop() ?? "";
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
