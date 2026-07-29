// Versions de planning d'un OF.
//
// Toute retouche d'un planning d'OF crée un **brouillon versionné**. Le planning
// ACTIF n'est jamais modifié en place : il le reste jusqu'à ce qu'un brouillon
// validé prenne sa succession.
//
//     ACTIF -> BROUILLON -> SOUMIS -> VALIDE  -> ACTIF
//                        \-> REFUSE
//
// La comparaison avant/après est calculée à la création du brouillon et figée avec
// lui : c'est elle qui dit s'il y a un impact client, donc si un dossier d'AR à
// recaler doit être ouvert après validation.

import { canonicalJson, hashSnapshot, type OfPhaseFamily } from "./of-revision";

export const OF_PLANNING_STATUTS = [
  "ACTIF",
  "BROUILLON",
  "SOUMIS",
  "VALIDE",
  "REFUSE",
  "SUPERSEDE",
] as const;
export type OfPlanningStatut = (typeof OF_PLANNING_STATUTS)[number];

export const OF_PLANNING_STATUT_LABELS: Record<OfPlanningStatut, string> = {
  ACTIF: "Actif",
  BROUILLON: "Brouillon",
  SOUMIS: "Soumis",
  VALIDE: "Validé",
  REFUSE: "Refusé",
  SUPERSEDE: "Remplacé",
};

/**
 * Transitions licites.
 *
 * `VALIDE -> ACTIF` est l'activation : elle bascule l'ancien ACTIF en SUPERSEDE.
 * `REFUSE` est terminal — un brouillon refusé ne se recycle pas, on en crée un
 * autre, pour que la trace du refus reste lisible.
 */
export const OF_PLANNING_TRANSITIONS: Record<OfPlanningStatut, readonly OfPlanningStatut[]> = {
  ACTIF: ["SUPERSEDE"],
  BROUILLON: ["SOUMIS", "REFUSE"],
  SOUMIS: ["VALIDE", "REFUSE", "BROUILLON"],
  VALIDE: ["ACTIF"],
  REFUSE: [],
  SUPERSEDE: [],
};

export function canTransitionPlanningStatut(from: OfPlanningStatut, to: OfPlanningStatut): boolean {
  if (from === to) return true;
  return OF_PLANNING_TRANSITIONS[from].includes(to);
}

export type OfPlanningTransitionCheck =
  | { allowed: true }
  | { allowed: false; code: string; message: string };

export function checkPlanningTransition(
  from: OfPlanningStatut,
  to: OfPlanningStatut
): OfPlanningTransitionCheck {
  if (canTransitionPlanningStatut(from, to)) return { allowed: true };
  return {
    allowed: false,
    code: "TRANSITION_INTERDITE",
    message: `Transition de planning interdite : ${OF_PLANNING_STATUT_LABELS[from]} -> ${OF_PLANNING_STATUT_LABELS[to]}.`,
  };
}

// ---------------------------------------------------------------------------
// Charge utile d'une version de planning
// ---------------------------------------------------------------------------

/** Une opération planifiée : ce que le planning décide, phase par phase. */
export type OfPlannedOperation = {
  phase: number;
  designation: string;
  family: OfPhaseFamily | null;
  machineId: string | null;
  machineLabel: string | null;
  /** Début planifié, ISO. */
  debut: string | null;
  /** Fin planifiée, ISO. */
  fin: string | null;
  /** Durée planifiée, en heures. */
  dureeH: number;
  quantite: number;
};

/** Cadence de livraison décidée : une quantité par échéance. */
export type OfCadenceEcheance = {
  /** Date de l'échéance, ISO (AAAA-MM-JJ). */
  date: string;
  quantite: number;
  /** Affaire de livraison portant l'échéance. */
  affaireId: number | null;
};

export type OfDeliveryEngagement = {
  affaireId: number;
  affaireNumero: string | null;
  commandeId: number | null;
  commandeNumero: string | null;
  clientId: string | null;
  /** Engagement client accusé, ISO (AAAA-MM-JJ). */
  delaiClient: string | null;
  quantite: number;
};

export type OfPlanningPayload = {
  schema: "of-planning/1";
  ofId: number;
  ofNumero: string;
  revisionCode: string | null;
  /** Quantité couverte par ce plan. */
  quantite: number;
  dateDebut: string | null;
  dateFin: string | null;
  /** Charge totale planifiée, en heures. */
  chargeTotaleH: number;
  operations: OfPlannedOperation[];
  cadence: OfCadenceEcheance[];
  engagements: OfDeliveryEngagement[];
};

export function buildPlanningPayload(
  input: Omit<OfPlanningPayload, "schema">
): OfPlanningPayload {
  return {
    schema: "of-planning/1",
    ...input,
    operations: [...input.operations].sort((a, b) => a.phase - b.phase),
    cadence: [...input.cadence].sort((a, b) => a.date.localeCompare(b.date)),
    engagements: [...input.engagements].sort((a, b) => a.affaireId - b.affaireId),
  };
}

export function hashPlanningPayload(payload: OfPlanningPayload): string {
  return hashSnapshot(payload);
}

export function planningPayloadsIdentical(a: OfPlanningPayload, b: OfPlanningPayload): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

// ---------------------------------------------------------------------------
// Comparaison avant / après
// ---------------------------------------------------------------------------

export const OF_CLIENT_IMPACTS = ["AUCUN", "DELAI", "CADENCE", "DELAI_ET_CADENCE"] as const;
export type OfClientImpact = (typeof OF_CLIENT_IMPACTS)[number];

export type OfPlanningChange = {
  field: string;
  before: unknown;
  after: unknown;
};

export type OfPlanningOperationChange = {
  phase: number;
  kind: "AJOUTEE" | "RETIREE" | "MODIFIEE";
  changes: OfPlanningChange[];
};

export type OfPlanningComparison = {
  schema: "of-planning-comparison/1";
  identical: boolean;
  /** Écarts d'entête : quantité, dates, charge. */
  header: OfPlanningChange[];
  operations: OfPlanningOperationChange[];
  /** Écarts de cadence, échéance par échéance. */
  cadence: Array<{
    date: string;
    /** Affaire de livraison portant l'échéance, quand elle est connue. */
    affaireId: number | null;
    kind: "AJOUTEE" | "RETIREE" | "MODIFIEE";
    quantiteAvant: number | null;
    quantiteApres: number | null;
  }>;
  /** Engagements client et leur tenue après retouche. */
  engagements: Array<{
    affaireId: number;
    affaireNumero: string | null;
    commandeId: number | null;
    clientId: string | null;
    delaiClient: string | null;
    /** Date de livraison estimée par le nouveau plan. */
    nouvelleDate: string | null;
    /** `true` quand la nouvelle date dépasse l'engagement accusé. */
    depasse: boolean;
    /** Jours de retard, positif seulement. */
    retardJours: number;
  }>;
  summary: {
    operationsAjoutees: number;
    operationsRetirees: number;
    operationsModifiees: number;
    machinesChangees: number;
    deltaChargeH: number;
    deltaFinJours: number | null;
    cadenceModifiee: boolean;
    engagementsDepasses: number;
  };
  clientImpact: OfClientImpact;
};

const OPERATION_FIELDS: Array<keyof OfPlannedOperation> = [
  "designation",
  "family",
  "machineId",
  "machineLabel",
  "debut",
  "fin",
  "dureeH",
  "quantite",
];

/** Écart en jours entiers entre deux dates ISO. `null` si l'une manque. */
export function diffDays(from: string | null, to: string | null): number | null {
  if (!from || !to) return null;
  const a = Date.parse(from.length <= 10 ? `${from}T00:00:00Z` : from);
  const b = Date.parse(to.length <= 10 ? `${to}T00:00:00Z` : to);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

/**
 * Compare le plan actif au brouillon et en déduit l'impact client.
 *
 * L'impact client ne se devine pas d'un décalage interne : seul le dépassement
 * d'un engagement **accusé** (délai) ou la modification de la cadence promise
 * touche le client. Un OF replanifié qui livre à la même date, à la même cadence,
 * ne le concerne pas.
 */
export function comparePlanningVersions(
  before: OfPlanningPayload | null,
  after: OfPlanningPayload
): OfPlanningComparison {
  const header: OfPlanningChange[] = [];
  const operations: OfPlanningOperationChange[] = [];

  if (before) {
    for (const field of ["quantite", "dateDebut", "dateFin", "chargeTotaleH"] as const) {
      if (!sameValue(before[field], after[field])) {
        header.push({ field, before: before[field] ?? null, after: after[field] ?? null });
      }
    }
  }

  const beforeOps = new Map((before?.operations ?? []).map((op) => [op.phase, op]));
  const afterOps = new Map(after.operations.map((op) => [op.phase, op]));

  for (const [phase, op] of afterOps) {
    const previous = beforeOps.get(phase);
    if (!previous) {
      operations.push({ phase, kind: "AJOUTEE", changes: [] });
      continue;
    }
    const changes: OfPlanningChange[] = [];
    for (const field of OPERATION_FIELDS) {
      if (!sameValue(previous[field], op[field])) {
        changes.push({ field, before: previous[field] ?? null, after: op[field] ?? null });
      }
    }
    if (changes.length) operations.push({ phase, kind: "MODIFIEE", changes });
  }
  for (const [phase] of beforeOps) {
    if (!afterOps.has(phase)) operations.push({ phase, kind: "RETIREE", changes: [] });
  }
  operations.sort((a, b) => a.phase - b.phase);

  // Cadence — la clé est le couple (affaire, date) : deux affaires peuvent livrer
  // le même jour sans que leurs échéances se confondent.
  const cadenceKey = (entry: OfCadenceEcheance) => `${entry.affaireId ?? ""}|${entry.date}`;
  const beforeCadence = new Map((before?.cadence ?? []).map((c) => [cadenceKey(c), c]));
  const afterCadence = new Map(after.cadence.map((c) => [cadenceKey(c), c]));
  const cadence: OfPlanningComparison["cadence"] = [];

  for (const [key, entry] of afterCadence) {
    const previous = beforeCadence.get(key);
    if (!previous) {
      cadence.push({
        date: entry.date,
        affaireId: entry.affaireId,
        kind: "AJOUTEE",
        quantiteAvant: null,
        quantiteApres: entry.quantite,
      });
    } else if (!sameValue(previous.quantite, entry.quantite)) {
      cadence.push({
        date: entry.date,
        affaireId: entry.affaireId,
        kind: "MODIFIEE",
        quantiteAvant: previous.quantite,
        quantiteApres: entry.quantite,
      });
    }
  }
  for (const [key, entry] of beforeCadence) {
    if (!afterCadence.has(key)) {
      cadence.push({
        date: entry.date,
        affaireId: entry.affaireId,
        kind: "RETIREE",
        quantiteAvant: entry.quantite,
        quantiteApres: null,
      });
    }
  }
  cadence.sort((a, b) => a.date.localeCompare(b.date) || (a.affaireId ?? 0) - (b.affaireId ?? 0));

  // Engagements client : la nouvelle date de livraison est la fin du plan, sauf
  // si une échéance de cadence porte explicitement l'affaire.
  const engagements: OfPlanningComparison["engagements"] = after.engagements.map((engagement) => {
    const echeance = after.cadence
      .filter((c) => c.affaireId === engagement.affaireId)
      .map((c) => c.date)
      .sort()
      .at(-1);
    const nouvelleDate = echeance ?? after.dateFin ?? null;
    const retard = diffDays(engagement.delaiClient, nouvelleDate);
    const retardJours = retard !== null && retard > 0 ? retard : 0;
    return {
      affaireId: engagement.affaireId,
      affaireNumero: engagement.affaireNumero,
      commandeId: engagement.commandeId,
      clientId: engagement.clientId,
      delaiClient: engagement.delaiClient,
      nouvelleDate,
      depasse: retardJours > 0,
      retardJours,
    };
  });

  const machinesChangees = operations.filter((op) =>
    op.changes.some((change) => change.field === "machineId")
  ).length;

  const engagementsDepasses = engagements.filter((e) => e.depasse).length;
  const cadenceModifiee = cadence.length > 0;

  const clientImpact: OfClientImpact =
    engagementsDepasses > 0 && cadenceModifiee
      ? "DELAI_ET_CADENCE"
      : engagementsDepasses > 0
        ? "DELAI"
        : cadenceModifiee
          ? "CADENCE"
          : "AUCUN";

  return {
    schema: "of-planning-comparison/1",
    identical: before ? planningPayloadsIdentical(before, after) : false,
    header,
    operations,
    cadence,
    engagements,
    summary: {
      operationsAjoutees: operations.filter((o) => o.kind === "AJOUTEE").length,
      operationsRetirees: operations.filter((o) => o.kind === "RETIREE").length,
      operationsModifiees: operations.filter((o) => o.kind === "MODIFIEE").length,
      machinesChangees,
      deltaChargeH: round4(after.chargeTotaleH - (before?.chargeTotaleH ?? 0)),
      deltaFinJours: before ? diffDays(before.dateFin, after.dateFin) : null,
      cadenceModifiee,
      engagementsDepasses,
    },
    clientImpact,
  };
}

/** Un plan validé sans impact client se publie directement, sans dossier d'AR. */
export function requiresArRecalage(comparison: OfPlanningComparison): boolean {
  return comparison.clientImpact !== "AUCUN";
}

function sameValue(a: unknown, b: unknown): boolean {
  const left = a ?? null;
  const right = b ?? null;
  if (typeof left === "number" && typeof right === "number") {
    return Math.abs(left - right) < 1e-9;
  }
  return left === right;
}

function round4(value: number): number {
  return Math.round(value * 1e4) / 1e4;
}
