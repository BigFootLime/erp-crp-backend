import crypto from "crypto";

import { HttpError } from "../../utils/httpError";

/**
 * Codification MATIÈRE PREMIÈRE — générateur autoritaire unique.
 *
 * Pourquoi ce fichier existe
 * --------------------------
 * Jusqu'ici trois règles concurrentes cohabitaient pour une même matière :
 *   1. le dialogue frontend calculait `PL-S235-BRUT-100x10x3000` et l'affichait ;
 *   2. `apiCreateStockArticle` supprimait ce code du payload ;
 *   3. le serveur allouait finalement `ART-<FAMILLE>-<SEQ6>`.
 * L'aperçu montré à l'utilisateur n'avait donc AUCUN rapport avec le code créé.
 *
 * Ce module est désormais la seule règle. Il est appelé par l'aperçu ET par la
 * création : les deux ne peuvent plus diverger puisqu'ils exécutent la même
 * fonction pure sur les mêmes données résolues en base.
 *
 * Invariants
 * ----------
 * · aucun code proposé par le navigateur n'est retenu ;
 * · aucune valeur n'est inventée : un segment absent est ABSENT, jamais `XXX` ;
 * · les séparateurs métier `-` et `x` sont conservés (lisibilité atelier) ;
 * · le résultat est déterministe, donc rejouable et testable hors base.
 */

/** Segment de tête, aligné sur `code_segment` du référentiel des catégories. */
export const MATERIAL_CODE_PREFIX = "MP";

export type MaterialProfileCode = "PL" | "RO" | "U" | "FOND" | "TUBE" | "PROFIL" | "BRUTCL";

export const MATERIAL_PROFILE_CODES: readonly MaterialProfileCode[] = [
  "PL",
  "RO",
  "U",
  "FOND",
  "TUBE",
  "PROFIL",
  "BRUTCL",
] as const;

/** Libellés métier utilisés pour la désignation canonique. */
const MATERIAL_PROFILE_LABELS: Record<MaterialProfileCode, string> = {
  PL: "PLAT/TOLE",
  RO: "ROND",
  U: "U",
  FOND: "ACHAT FONDERIE",
  TUBE: "TUBE",
  PROFIL: "PROFILS DIVERS",
  BRUTCL: "BRUT CLIENT",
};

/**
 * Alias historiques rencontrés en base et dans les anciens écrans. Ils sont
 * ramenés au code canonique AVANT toute génération : deux orthographes ne
 * doivent jamais produire deux codes différents pour la même matière.
 */
const MATERIAL_PROFILE_ALIASES: Record<string, MaterialProfileCode> = {
  PL: "PL",
  PLAT: "PL",
  PLATTOLE: "PL",
  TOLE: "PL",
  RO: "RO",
  ROND: "RO",
  U: "U",
  FOND: "FOND",
  FONDERI: "FOND",
  FONDERIE: "FOND",
  ACHATFONDERIE: "FOND",
  TUBE: "TUBE",
  TU: "TUBE",
  PROFIL: "PROFIL",
  PROFI: "PROFIL",
  PR: "PROFIL",
  PROFILSDIVERS: "PROFIL",
  BRUTCL: "BRUTCL",
  BRUTCLIENT: "BRUTCL",
};

/** Profils dont la référence repose sur un suffixe métier, pas sur une géométrie. */
const SPECIAL_PROFILES: ReadonlySet<MaterialProfileCode> = new Set<MaterialProfileCode>([
  "FOND",
  "PROFIL",
  "BRUTCL",
]);

export function isSpecialMaterialProfile(profile: MaterialProfileCode): boolean {
  return SPECIAL_PROFILES.has(profile);
}

function stripDiacritics(value: string): string {
  return value.normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

/** Segment d'identité : majuscules ASCII, séparateurs internes ramenés à `-`. */
function normalizeSegment(value: string | null | undefined): string {
  if (typeof value !== "string") return "";
  return stripDiacritics(value)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

/** Clé de comparaison d'un profil : lettres et chiffres uniquement. */
function profileLookupKey(value: string): string {
  return stripDiacritics(value).toUpperCase().replace(/[^A-Z0-9]+/g, "");
}

/**
 * Ramène un code famille/profil au code canonique. Une valeur inconnue est
 * refusée : générer une référence matière à partir d'un profil non reconnu
 * produirait un code que personne ne sait relire.
 */
export function normalizeMaterialProfile(value: string | null | undefined): MaterialProfileCode {
  const key = profileLookupKey(typeof value === "string" ? value : "");
  const canonical = MATERIAL_PROFILE_ALIASES[key];
  if (!canonical) {
    throw new HttpError(
      400,
      "INVALID_MATERIAL_PROFILE",
      `Profil matière inconnu : ${value ?? "(vide)"}. Profils acceptés : ${MATERIAL_PROFILE_CODES.join(", ")}.`
    );
  }
  return canonical;
}

export function isMaterialProfileCode(value: string | null | undefined): boolean {
  const key = profileLookupKey(typeof value === "string" ? value : "");
  return Boolean(MATERIAL_PROFILE_ALIASES[key]);
}

export type MaterialDimensions = {
  barre_a_decouper?: boolean | null;
  longueur_barre_source_mm?: number | null;
  longueur_coupe_mm?: number | null;
  longueur_brut_mm?: number | null;
  longueur_mm?: number | null;
  largeur_mm?: number | null;
  hauteur_mm?: number | null;
  epaisseur_mm?: number | null;
  diametre_mm?: number | null;
  largeur_plat_mm?: number | null;
};

export type MaterialCodeInput = {
  profile: MaterialProfileCode;
  /** Code du référentiel `stock_nuances`, résolu en base. */
  nuance_code?: string | null;
  /** Code du référentiel `stock_etats`, résolu en base. */
  etat_code?: string | null;
  /** Code du référentiel `stock_sous_etats`, résolu en base. */
  sous_etat_code?: string | null;
  /** Code client propriétaire (`clients.client_code`) pour un brut client. */
  client_code?: string | null;
  /** Suffixe métier saisi pour FOND / PROFIL / BRUTCL. */
  reference_suffix?: string | null;
  dimensions?: MaterialDimensions | null;
};

export type MaterialCodeResult = {
  code: string;
  designation: string;
  /** Segments retenus, dans l'ordre, pour expliquer la référence à l'écran. */
  segments: string[];
  /** Segment dimensionnel isolé (`100x10x3000`) ou `null` si aucune cote fournie. */
  dimensions_segment: string | null;
};

function toPositiveInt(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  const i = Math.trunc(n);
  return i > 0 ? i : null;
}

/**
 * Longueur retenue dans la référence.
 *
 * Une barre à découper n'a pas de longueur d'article : sa longueur source est
 * une donnée d'approvisionnement qui varie d'une réception à l'autre. L'inclure
 * créerait un article différent par barre reçue.
 */
function codeLength(dims: MaterialDimensions): number | null {
  if (dims.barre_a_decouper) return null;
  return toPositiveInt(dims.longueur_brut_mm ?? dims.longueur_coupe_mm ?? dims.longueur_mm);
}

/**
 * Cotes retenues par profil, dans l'ordre de lecture atelier.
 * Une cote absente est simplement omise ; rien n'est comblé.
 */
export function buildMaterialDimensionsSegment(
  profile: MaterialProfileCode,
  dimensions: MaterialDimensions | null | undefined
): string | null {
  if (isSpecialMaterialProfile(profile)) return null;
  const dims = dimensions ?? {};

  const longueur = codeLength(dims);
  const largeur = toPositiveInt(dims.largeur_mm);
  const hauteur = toPositiveInt(dims.hauteur_mm);
  const epaisseur = toPositiveInt(dims.epaisseur_mm);
  const diametre = toPositiveInt(dims.diametre_mm);

  const ordered: Array<number | null> = (() => {
    switch (profile) {
      case "PL":
        return [largeur, epaisseur, longueur];
      case "RO":
        return [diametre, longueur];
      case "TUBE":
        return [diametre, epaisseur, longueur];
      case "U":
        return [largeur, hauteur, epaisseur, longueur];
      default:
        return [longueur];
    }
  })();

  const parts = ordered.filter((value): value is number => typeof value === "number");
  return parts.length ? parts.join("x") : null;
}

/**
 * Construit la référence matière et sa désignation canonique.
 *
 * Contrat des profils particuliers :
 * · `FOND` et `PROFIL` — la géométrie n'identifie rien, un suffixe métier est exigé ;
 * · `BRUTCL` — la propriété client fait partie de l'identité : code client ET suffixe.
 */
export function buildMaterialArticleCode(input: MaterialCodeInput): MaterialCodeResult {
  const profile = input.profile;

  if (isSpecialMaterialProfile(profile)) {
    const suffix = normalizeSegment(input.reference_suffix);
    if (!suffix) {
      throw new HttpError(
        400,
        "MATERIAL_REFERENCE_SUFFIX_REQUIRED",
        `Le profil ${MATERIAL_PROFILE_LABELS[profile]} exige une référence métier : aucune dimension ne l'identifie.`
      );
    }

    const clientSegment = profile === "BRUTCL" ? normalizeSegment(input.client_code) : "";
    if (profile === "BRUTCL" && !clientSegment) {
      throw new HttpError(
        400,
        "MATERIAL_CLIENT_CODE_REQUIRED",
        "Un brut client exige le code du client propriétaire pour construire sa référence."
      );
    }

    const segments = [MATERIAL_CODE_PREFIX, profile, ...(clientSegment ? [clientSegment] : []), suffix];
    const designation = [MATERIAL_PROFILE_LABELS[profile], clientSegment || null, suffix]
      .filter((value): value is string => Boolean(value))
      .join(" ");

    return { code: segments.join("-"), designation, segments, dimensions_segment: null };
  }

  const nuance = normalizeSegment(input.nuance_code);
  if (!nuance) {
    throw new HttpError(
      400,
      "MATERIAL_NUANCE_REQUIRED",
      "La nuance est obligatoire pour construire la référence matière."
    );
  }
  const etat = normalizeSegment(input.etat_code);
  if (!etat) {
    throw new HttpError(
      400,
      "MATERIAL_ETAT_REQUIRED",
      "L'état est obligatoire pour construire la référence matière."
    );
  }
  const sousEtat = normalizeSegment(input.sous_etat_code);
  const dimensionsSegment = buildMaterialDimensionsSegment(profile, input.dimensions);

  const segments = [
    MATERIAL_CODE_PREFIX,
    profile,
    nuance,
    etat,
    ...(sousEtat ? [sousEtat] : []),
    ...(dimensionsSegment ? [dimensionsSegment] : []),
  ];

  const designation = [
    MATERIAL_PROFILE_LABELS[profile],
    nuance,
    etat,
    sousEtat || null,
    dimensionsSegment ? `${dimensionsSegment} mm` : null,
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ");

  return { code: segments.join("-"), designation, segments, dimensions_segment: dimensionsSegment };
}

/**
 * Empreinte de l'aperçu matière, sur le MÊME motif que la bibliothèque de
 * finitions : elle couvre l'entrée résolue et le code proposé. Le navigateur la
 * renvoie à la création ; si le référentiel a bougé entre-temps, la confirmation
 * est refusée au lieu de créer une référence différente de celle affichée.
 */
export function computeMaterialCodePreviewHash(params: {
  input: MaterialCodeInput;
  code: string;
  designation: string;
}): string {
  const dims = params.input.dimensions ?? {};
  const canonical = {
    kind: "material_article_code_preview",
    version: 1,
    profile: params.input.profile,
    nuance_code: normalizeSegment(params.input.nuance_code) || null,
    etat_code: normalizeSegment(params.input.etat_code) || null,
    sous_etat_code: normalizeSegment(params.input.sous_etat_code) || null,
    client_code: normalizeSegment(params.input.client_code) || null,
    reference_suffix: normalizeSegment(params.input.reference_suffix) || null,
    dimensions: {
      barre_a_decouper: Boolean(dims.barre_a_decouper),
      longueur_barre_source_mm: toPositiveInt(dims.longueur_barre_source_mm),
      longueur_coupe_mm: toPositiveInt(dims.longueur_coupe_mm),
      longueur_brut_mm: toPositiveInt(dims.longueur_brut_mm),
      longueur_mm: toPositiveInt(dims.longueur_mm),
      largeur_mm: toPositiveInt(dims.largeur_mm),
      hauteur_mm: toPositiveInt(dims.hauteur_mm),
      epaisseur_mm: toPositiveInt(dims.epaisseur_mm),
      diametre_mm: toPositiveInt(dims.diametre_mm),
      largeur_plat_mm: toPositiveInt(dims.largeur_plat_mm),
    },
    code: params.code,
    designation: params.designation,
  };
  return crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function assertMaterialPreviewFresh(expected: string | null | undefined, current: string): void {
  const value = (expected ?? "").trim();
  if (!value) return; // L'aperçu reste facultatif : un client historique n'est pas cassé.
  if (value !== current) {
    throw new HttpError(
      409,
      "MATERIAL_CODE_PREVIEW_STALE",
      "La référence matière affichée n'est plus à jour : rechargez l'aperçu avant de créer l'article."
    );
  }
}
