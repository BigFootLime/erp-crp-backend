// Révisions d'OF — numéro stable, révision qui porte l'évolution.
//
// Le numéro d'OF ne bouge jamais (trigger `fn_prevent_of_numero_mutation`, #170).
// Ce qui évolue est la révision : R00 à la création, R01, R02… ensuite. Chaque
// révision fige un instantané technique complet et se compare à la précédente.
//
// Règle structurante : **une modification n'écrase jamais un OF lancé**. Créer une
// révision ne mute pas les opérations existantes, elle en crée un nouveau jeu. Les
// pointages et les VISA restent donc rattachés aux opérations de la révision sous
// laquelle ils ont été enregistrés — c'est l'unicité (of_id, revision_id, phase)
// en base qui rend cette coexistence possible.

import { createHash } from "node:crypto";

/**
 * Famille d'usinage d'une phase : un **code du référentiel**
 * `production_machine_families`, pas une constante du code.
 *
 * Ce référentiel est administrable par les Méthodes depuis la normalisation des
 * gammes. Figer ici une union `"T" | "F" | "TTRAD" | "FTRAD"` rendrait la table
 * d'administration décorative : ajouter une famille exigerait une livraison
 * applicative, et `DECOUPE` — qui existe déjà en base — serait rejeté par le
 * typage alors que la base l'accepte.
 *
 * Le contrôle de validité se fait donc contre le référentiel chargé, pas contre
 * une liste écrite en dur : voir `assertKnownFamily`.
 */
export type OfPhaseFamily = string;

/** Une famille telle que le référentiel la décrit. */
export type MachineFamilyRef = {
  code: string;
  libelle: string;
  /** `true` = le n° de programme est obligatoire sur une phase de cette famille. */
  programmeRequis: boolean;
  ordreAffichage: number;
  actif: boolean;
};

/**
 * Libellés de repli des familles amorcées par le patch de normalisation.
 *
 * Uniquement pour l'affichage lorsque le référentiel n'a pas pu être chargé (un
 * rendu ne doit pas échouer parce qu'une jointure a manqué). Ce n'est **pas** la
 * liste de référence : elle vit en base.
 */
export const OF_PHASE_FAMILY_FALLBACK_LABELS: Record<string, string> = {
  T: "Tournage CN",
  F: "Fraisage CN",
  TTRAD: "Tour conventionnel",
  FTRAD: "Fraisage conventionnel",
  DECOUPE: "Découpe",
};

/** Forme d'un code de famille, alignée sur `production_machine_families_code_ck`. */
const FAMILY_CODE_RE = /^[A-Z0-9_]{1,24}$/;

export function isOfPhaseFamily(value: unknown): value is OfPhaseFamily {
  return typeof value === "string" && FAMILY_CODE_RE.test(value);
}

/** Libellé d'une famille : le référentiel d'abord, le repli ensuite, le code sinon. */
export function familyLabel(
  code: string | null | undefined,
  referential?: readonly MachineFamilyRef[]
): string | null {
  if (!code) return null;
  const known = referential?.find((f) => f.code === code);
  if (known) return known.libelle;
  return OF_PHASE_FAMILY_FALLBACK_LABELS[code] ?? code;
}

/**
 * Refuse une famille absente du référentiel.
 *
 * `null` reste accepté : une phase dont la famille n'est pas déterminable est un
 * fait, et le document la signale. Ce qui est refusé, c'est une famille
 * *inventée* — elle produirait une gamme qui ne correspond à aucun atelier.
 */
export function assertKnownFamily(
  code: string | null | undefined,
  referential: readonly MachineFamilyRef[]
): string | null {
  if (code === null || code === undefined || code === "") return null;
  if (!isOfPhaseFamily(code)) {
    throw new Error(`Code de famille machine invalide : ${JSON.stringify(code)}`);
  }
  if (!referential.some((f) => f.code === code)) {
    throw new Error(
      `Famille machine inconnue du référentiel : ${code}. Les familles sont administrées dans production_machine_families.`
    );
  }
  return code;
}

export const OF_REVISION_STATUTS = ["BROUILLON", "ACTIVE", "OBSOLETE"] as const;
export type OfRevisionStatut = (typeof OF_REVISION_STATUTS)[number];

/** Une phase de la gamme applicable, telle que figée dans la révision. */
export type OfRevisionOperation = {
  phase: number;
  designation: string;
  /** `null` quand la famille n'est pas déterminable : on ne l'invente pas. */
  family: OfPhaseFamily | null;
  machineId: string | null;
  machineLabel: string | null;
  /** N° de programme CN. `null` = absent, et le document le signale. */
  programme: string | null;
  /** Temps unitaire, en heures. */
  tempsUnitaire: number;
  /** Temps de préparation (TP), en heures. */
  preparation: number;
  /** Quantité de base servant au calcul de la fabrication. */
  quantiteBase: number;
  coefficient: number;

  // --- Gel du centre de frais (normalisation des gammes) --------------------
  // Le taux horaire ne se saisit plus sur l'opération : il vient d'un tarif de
  // centre de frais daté. La révision fige QUEL tarif a servi, sinon un tarif
  // clos plus tard rendrait le coût de la révision irreproductible.
  /** Code du centre de frais, recopié — pas une clé étrangère : c'est une preuve. */
  cfCode: string | null;
  /** Tarif de centre de frais ayant produit `tauxHoraire`. */
  cfRateId: string | null;
  /** Taux horaire appliqué, en euros. */
  tauxHoraire: number | null;
  /** D'où vient le taux : 'CENTRE_FRAIS', 'HISTORIQUE_LEGACY' ou 'ABSENT'. */
  tauxHoraireSource: string | null;
  /** Date de prise d'effet du tarif retenu, au format ISO. */
  tauxHoraireEffectiveAt: string | null;
};

/** Matière et débit, tels que figés dans la révision. */
export type OfRevisionMatiere = {
  reference: string | null;
  designation: string | null;
  nuance: string | null;
  /** Longueur d'un brut, en millimètres. */
  longueurBrutMm: number | null;
  nombreBruts: number | null;
  piecesParBrut: number | null;
  /** Masse totale, en kilogrammes. */
  masseTotaleKg: number | null;
};

export type OfRevisionSnapshotInput = {
  ofId: number;
  ofNumero: string;
  pieceReference: string | null;
  pieceDesignation: string | null;
  pieceIndice: string | null;
  gammeId: string | null;
  gammeCode: string | null;
  gammeVersion: string | null;
  quantiteLancee: number;
  matiere: OfRevisionMatiere | null;
  operations: OfRevisionOperation[];
};

/**
 * Instantané canonique d'une révision.
 *
 * Les clés sont ordonnées et les nombres normalisés : deux instantanés de même
 * contenu produisent la même chaîne, donc la même empreinte. Sans cette
 * canonicalisation, l'ordre d'insertion des clés suffirait à faire diverger deux
 * hachages identiques sur le fond.
 */
export type OfRevisionSnapshot = OfRevisionSnapshotInput & { schema: "of-revision/1" };

/** Formate un rang en code de révision : 0 -> « R00 », 12 -> « R12 », 100 -> « R100 ». */
export function formatRevisionCode(rank: number): string {
  if (!Number.isInteger(rank) || rank < 0) {
    throw new Error(`Rang de révision invalide : ${rank}`);
  }
  return `R${String(rank).padStart(2, "0")}`;
}

export function parseRevisionCode(code: string): number | null {
  const match = /^R(\d{2,})$/.exec(code.trim());
  if (!match) return null;
  return Number.parseInt(match[1], 10);
}

/** Rang de la révision suivante. */
export function nextRevisionRank(currentRank: number | null): number {
  if (currentRank === null) return 0;
  return currentRank + 1;
}

/**
 * Sérialisation canonique : clés triées à toute profondeur, `undefined` écarté.
 *
 * `JSON.stringify` conserve l'ordre d'insertion. Deux objets équivalents produits
 * par deux chemins de code donneraient alors deux empreintes différentes, et une
 * réimpression semblerait porter sur un contenu modifié.
 */
export function canonicalJson(value: unknown): string {
  const walk = (node: unknown): unknown => {
    if (node === null || typeof node !== "object") {
      // -0 et 0 sont le même nombre métier ; ils doivent hacher pareil.
      return typeof node === "number" && Object.is(node, -0) ? 0 : node;
    }
    if (Array.isArray(node)) return node.map(walk);
    const source = node as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      if (source[key] === undefined) continue;
      out[key] = walk(source[key]);
    }
    return out;
  };
  return JSON.stringify(walk(value));
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Empreinte d'un instantané, calculée sur sa forme canonique. */
export function hashSnapshot(snapshot: unknown): string {
  return sha256Hex(canonicalJson(snapshot));
}

/** Construit l'instantané figé d'une révision, opérations triées par phase. */
export function buildRevisionSnapshot(input: OfRevisionSnapshotInput): OfRevisionSnapshot {
  return {
    schema: "of-revision/1",
    ...input,
    operations: [...input.operations].sort((a, b) => a.phase - b.phase),
  };
}

// ---------------------------------------------------------------------------
// Diff entre deux révisions
// ---------------------------------------------------------------------------

export type OfRevisionFieldChange = {
  field: string;
  before: unknown;
  after: unknown;
};

export type OfRevisionPhaseChange = {
  phase: number;
  kind: "AJOUTEE" | "RETIREE" | "MODIFIEE";
  changes: OfRevisionFieldChange[];
};

export type OfRevisionDiff = {
  schema: "of-revision-diff/1";
  /** `true` quand les deux instantanés ont la même empreinte. */
  identical: boolean;
  header: OfRevisionFieldChange[];
  matiere: OfRevisionFieldChange[];
  phases: OfRevisionPhaseChange[];
  summary: {
    phasesAjoutees: number;
    phasesRetirees: number;
    phasesModifiees: number;
    /** Écart de temps total planifié, en heures. */
    deltaTempsTotalH: number;
  };
};

const HEADER_FIELDS: Array<keyof OfRevisionSnapshotInput> = [
  "ofNumero",
  "pieceReference",
  "pieceDesignation",
  "pieceIndice",
  "gammeId",
  "gammeCode",
  "gammeVersion",
  "quantiteLancee",
];

const MATIERE_FIELDS: Array<keyof OfRevisionMatiere> = [
  "reference",
  "designation",
  "nuance",
  "longueurBrutMm",
  "nombreBruts",
  "piecesParBrut",
  "masseTotaleKg",
];

const PHASE_FIELDS: Array<keyof OfRevisionOperation> = [
  "designation",
  "family",
  "machineId",
  "machineLabel",
  "programme",
  "tempsUnitaire",
  "preparation",
  "quantiteBase",
  "coefficient",
  // Un changement de centre de frais ou de tarif change le coût de la gamme :
  // il doit apparaître dans le diff, sinon une révision « sans changement
  // visible » modifierait silencieusement le prix de revient.
  "cfCode",
  "cfRateId",
  "tauxHoraire",
  "tauxHoraireSource",
  "tauxHoraireEffectiveAt",
];

/** Temps final d'une phase : préparation + fabrication. */
export function phaseFinalTime(operation: OfRevisionOperation): number {
  return operation.preparation + phaseFabricationTime(operation);
}

/** Fabrication = temps unitaire x quantité de base x coefficient. */
export function phaseFabricationTime(operation: OfRevisionOperation): number {
  return operation.tempsUnitaire * operation.quantiteBase * operation.coefficient;
}

/** Temps total planifié d'un instantané, en heures. */
export function snapshotTotalTime(snapshot: OfRevisionSnapshotInput): number {
  return snapshot.operations.reduce((sum, operation) => sum + phaseFinalTime(operation), 0);
}

/** Compare deux instantanés et décrit l'écart, champ par champ. */
export function diffRevisionSnapshots(
  before: OfRevisionSnapshotInput | null,
  after: OfRevisionSnapshotInput
): OfRevisionDiff {
  if (!before) {
    return {
      schema: "of-revision-diff/1",
      identical: false,
      header: [],
      matiere: [],
      phases: after.operations
        .map<OfRevisionPhaseChange>((operation) => ({
          phase: operation.phase,
          kind: "AJOUTEE",
          changes: [],
        }))
        .sort((a, b) => a.phase - b.phase),
      summary: {
        phasesAjoutees: after.operations.length,
        phasesRetirees: 0,
        phasesModifiees: 0,
        deltaTempsTotalH: round4(snapshotTotalTime(after)),
      },
    };
  }

  const header: OfRevisionFieldChange[] = [];
  for (const field of HEADER_FIELDS) {
    if (!sameValue(before[field], after[field])) {
      header.push({ field, before: before[field] ?? null, after: after[field] ?? null });
    }
  }

  const matiere: OfRevisionFieldChange[] = [];
  for (const field of MATIERE_FIELDS) {
    const b = before.matiere?.[field] ?? null;
    const a = after.matiere?.[field] ?? null;
    if (!sameValue(b, a)) matiere.push({ field, before: b, after: a });
  }

  const beforeByPhase = new Map(before.operations.map((op) => [op.phase, op]));
  const afterByPhase = new Map(after.operations.map((op) => [op.phase, op]));
  const phases: OfRevisionPhaseChange[] = [];

  for (const [phase, op] of afterByPhase) {
    const previous = beforeByPhase.get(phase);
    if (!previous) {
      phases.push({ phase, kind: "AJOUTEE", changes: [] });
      continue;
    }
    const changes: OfRevisionFieldChange[] = [];
    for (const field of PHASE_FIELDS) {
      if (!sameValue(previous[field], op[field])) {
        changes.push({ field, before: previous[field] ?? null, after: op[field] ?? null });
      }
    }
    if (changes.length) phases.push({ phase, kind: "MODIFIEE", changes });
  }

  for (const [phase] of beforeByPhase) {
    if (!afterByPhase.has(phase)) phases.push({ phase, kind: "RETIREE", changes: [] });
  }

  phases.sort((a, b) => a.phase - b.phase);

  return {
    schema: "of-revision-diff/1",
    identical: hashSnapshot(before) === hashSnapshot(after),
    header,
    matiere,
    phases,
    summary: {
      phasesAjoutees: phases.filter((p) => p.kind === "AJOUTEE").length,
      phasesRetirees: phases.filter((p) => p.kind === "RETIREE").length,
      phasesModifiees: phases.filter((p) => p.kind === "MODIFIEE").length,
      deltaTempsTotalH: round4(snapshotTotalTime(after) - snapshotTotalTime(before)),
    },
  };
}

function sameValue(a: unknown, b: unknown): boolean {
  const left = a ?? null;
  const right = b ?? null;
  if (typeof left === "number" && typeof right === "number") {
    // Les temps viennent de `numeric` PostgreSQL : comparer au 1/10 000 d'heure
    // évite qu'un aller-retour de sérialisation passe pour une modification.
    return Math.abs(left - right) < 1e-9;
  }
  return left === right;
}

function round4(value: number): number {
  return Math.round(value * 1e4) / 1e4;
}

// ---------------------------------------------------------------------------
// Règles de création d'une révision
// ---------------------------------------------------------------------------

export type OfRevisionCreationCheck =
  | { allowed: true }
  | { allowed: false; code: string; message: string };

/**
 * Une révision ne se crée pas sans motif dès la R01, et un instantané identique
 * ne mérite pas une révision : elle ferait croire à un changement inexistant.
 */
export function checkRevisionCreation(args: {
  nextRank: number;
  motif: string | null | undefined;
  diff: OfRevisionDiff;
}): OfRevisionCreationCheck {
  const motif = typeof args.motif === "string" ? args.motif.trim() : "";

  if (args.nextRank > 0 && !motif) {
    return {
      allowed: false,
      code: "MOTIF_REQUIS",
      message: "Une révision d'OF exige un motif à partir de R01.",
    };
  }

  if (args.diff.identical) {
    return {
      allowed: false,
      code: "REVISION_IDENTIQUE",
      message: "La définition est inchangée : aucune révision à créer.",
    };
  }

  return { allowed: true };
}
