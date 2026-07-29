// Dérive du temps d'usinage — comparaison au temps validé de référence.
//
// Après programmation d'une phase, le temps de fabrication constaté est comparé au
// temps de référence :
//
//     variation_pct = ((nouveau - référence) / référence) x 100
//
// Le seuil est **strict** à 10,00 % : +9,99 % et +10,00 % ne déclenchent rien,
// +10,01 % ouvre une proposition de replanification. Référence absente ou nulle :
// revue obligatoire, sans pourcentage — diviser par zéro ne produit pas une
// information, il en détruit une.
//
// Une proposition ne modifie jamais le planning actif. Elle se soumet à décision.

import { familyLabel, type MachineFamilyRef, type OfPhaseFamily } from "./of-revision";

/** Seuil de tolérance, en pourcentage. Au-delà — strictement — on propose. */
export const OF_TIME_VARIANCE_THRESHOLD_PCT = 10;

export const OF_TIME_VARIANCE_OUTCOMES = ["RIEN", "REPLANIFICATION", "REVUE"] as const;
export type OfTimeVarianceOutcome = (typeof OF_TIME_VARIANCE_OUTCOMES)[number];

export const OF_TIME_VARIANCE_STATUTS = ["OUVERTE", "ACCEPTEE", "REFUSEE", "CADUQUE"] as const;
export type OfTimeVarianceStatut = (typeof OF_TIME_VARIANCE_STATUTS)[number];

/**
 * Causes d'une dérive. Volontairement identiques aux motifs de recalage d'AR :
 * une dérive qui finit par décaler un engagement client doit pouvoir porter la
 * même cause d'un bout à l'autre de la chaîne, sans retraduction.
 */
export const OF_TIME_VARIANCE_CAUSES = [
  "DERIVE_TEMPS_USINAGE",
  "MACHINE",
  "MATIERE",
  "QUALITE_REPRISE",
  "SOUS_TRAITANCE",
  "MODIFICATION_TECHNIQUE",
  "CAPACITE",
  "PRIORITE",
  "AUTRE",
] as const;
export type OfTimeVarianceCause = (typeof OF_TIME_VARIANCE_CAUSES)[number];

export const OF_TIME_VARIANCE_CAUSE_LABELS: Record<OfTimeVarianceCause, string> = {
  DERIVE_TEMPS_USINAGE: "Dérive temps d'usinage",
  MACHINE: "Machine",
  MATIERE: "Matière",
  QUALITE_REPRISE: "Qualité / reprise",
  SOUS_TRAITANCE: "Sous-traitance",
  MODIFICATION_TECHNIQUE: "Modification technique",
  CAPACITE: "Capacité",
  PRIORITE: "Priorité",
  AUTRE: "Autre",
};

export function isOfTimeVarianceCause(value: unknown): value is OfTimeVarianceCause {
  return typeof value === "string" && (OF_TIME_VARIANCE_CAUSES as readonly string[]).includes(value);
}

/**
 * Arrondi à 2 décimales, demi-tour hors de zéro, avec correction de la
 * représentation binaire.
 *
 * Indispensable ici : `(110 - 100) / 100 * 100` vaut `10.000000000000002` en
 * IEEE 754. Comparé brut à `> 10`, ce cas — explicitement « rien » dans la règle
 * métier — ouvrirait une proposition de replanification à chaque fois.
 */
export function roundPct(value: number): number {
  if (!Number.isFinite(value)) return value;
  const scaled = value * 100;
  const corrected = Math.round(scaled * 1e9) / 1e9;
  const sign = corrected < 0 ? -1 : 1;
  return (sign * Math.round(Math.abs(corrected))) / 100;
}

export type OfTimeVarianceAssessment = {
  /** `null` quand la référence est absente ou nulle. */
  variationPct: number | null;
  outcome: OfTimeVarianceOutcome;
  reviewRequired: boolean;
  reason: string;
};

/**
 * Applique la règle de seuil.
 *
 * Seule une dérive **à la hausse** au-delà du seuil ouvre une proposition. Une
 * baisse de temps libère de la charge et ne met aucun engagement en risque : elle
 * est mesurée et consignée, mais elle ne déclenche pas de replanification.
 */
export function assessTimeVariance(args: {
  referenceTime: number | null | undefined;
  newTime: number;
}): OfTimeVarianceAssessment {
  const reference = args.referenceTime;
  const next = args.newTime;

  if (!Number.isFinite(next) || next < 0) {
    throw new Error(`Temps de fabrication invalide : ${next}`);
  }

  if (reference === null || reference === undefined || !Number.isFinite(reference) || reference === 0) {
    return {
      variationPct: null,
      outcome: "REVUE",
      reviewRequired: true,
      reason: "Temps de référence absent ou nul : revue obligatoire avant replanification.",
    };
  }

  const variationPct = roundPct(((next - reference) / reference) * 100);

  if (variationPct > OF_TIME_VARIANCE_THRESHOLD_PCT) {
    return {
      variationPct,
      outcome: "REPLANIFICATION",
      reviewRequired: false,
      reason: `Dérive de ${formatPct(variationPct)} au-dessus du seuil de ${formatPct(OF_TIME_VARIANCE_THRESHOLD_PCT)}.`,
    };
  }

  return {
    variationPct,
    outcome: "RIEN",
    reviewRequired: false,
    reason:
      variationPct < 0
        ? `Temps en baisse de ${formatPct(Math.abs(variationPct))} : aucune replanification requise.`
        : `Dérive de ${formatPct(variationPct)} dans la tolérance de ${formatPct(OF_TIME_VARIANCE_THRESHOLD_PCT)}.`,
  };
}

/** « 10,01 % » — virgule décimale française, deux décimales. */
export function formatPct(value: number): string {
  return `${value.toFixed(2).replace(".", ",")} %`;
}

// ---------------------------------------------------------------------------
// Contexte d'impact figé avec la proposition
// ---------------------------------------------------------------------------

export type OfTimeVarianceMachine = {
  machineId: string | null;
  machineLabel: string | null;
  family: OfPhaseFamily | null;
  /** Écart de charge sur cette machine, en heures. */
  deltaHeures: number;
};

export type OfTimeVarianceAffaire = {
  affaireId: number;
  affaireNumero: string | null;
  clientId: string | null;
  clientNom: string | null;
  /** Date d'engagement en cours, au format ISO. */
  delaiClient: string | null;
};

export type OfTimeVarianceImpact = {
  /** Charge planifiée avant / après, en heures, sur le périmètre de l'OF. */
  chargeAvantH: number;
  chargeApresH: number;
  deltaH: number;
  /** Nombre d'opérations replanifiées par la simulation. */
  operationsImpactees: number;
};

/**
 * Simulation : ce que **deviendrait** le planning si la proposition était
 * acceptée. Elle est calculée et stockée, jamais appliquée — le planning actif
 * reste intact tant qu'une décision humaine n'a pas eu lieu.
 */
export type OfTimeVarianceSimulation = {
  schema: "of-time-variance-simulation/1";
  /** Décalage de fin d'OF induit, en jours ouvrés estimés. */
  decalageFinJours: number | null;
  dateFinAvant: string | null;
  dateFinApres: string | null;
  /** Engagements client menacés par le décalage. */
  engagementsEnRisque: Array<{
    affaireId: number;
    delaiClient: string | null;
    nouvelleDate: string | null;
    depasse: boolean;
  }>;
};

export type OfTimeVarianceProposal = {
  ofId: number;
  ofNumero: string;
  revisionId: string;
  revisionCode: string;
  ofOperationId: string | null;
  phase: number;
  family: OfPhaseFamily | null;
  referenceTime: number | null;
  newTime: number;
  variationPct: number | null;
  outcome: OfTimeVarianceOutcome;
  reviewRequired: boolean;
  cause: OfTimeVarianceCause;
  causeComment: string | null;
  authorUserId: number | null;
  impactCharge: OfTimeVarianceImpact;
  machines: OfTimeVarianceMachine[];
  affaires: OfTimeVarianceAffaire[];
  simulation: OfTimeVarianceSimulation;
};

export type OfTimeVarianceBuildResult =
  | { created: false; assessment: OfTimeVarianceAssessment }
  | { created: true; assessment: OfTimeVarianceAssessment; proposal: OfTimeVarianceProposal };

/**
 * Construit la proposition quand la règle l'exige.
 *
 * `RIEN` ne produit aucune proposition : consigner une non-dérive noierait les
 * vraies alertes du planificateur.
 */
export function buildTimeVarianceProposal(args: {
  ofId: number;
  ofNumero: string;
  revisionId: string;
  revisionCode: string;
  ofOperationId: string | null;
  phase: number;
  family: OfPhaseFamily | null;
  referenceTime: number | null;
  newTime: number;
  cause: OfTimeVarianceCause;
  causeComment: string | null;
  authorUserId: number | null;
  impactCharge: OfTimeVarianceImpact;
  machines: OfTimeVarianceMachine[];
  affaires: OfTimeVarianceAffaire[];
  simulation: OfTimeVarianceSimulation;
}): OfTimeVarianceBuildResult {
  const assessment = assessTimeVariance({
    referenceTime: args.referenceTime,
    newTime: args.newTime,
  });

  if (assessment.outcome === "RIEN") return { created: false, assessment };

  // « Autre » n'est pas une cause tant qu'elle n'est pas écrite.
  if (args.cause === "AUTRE" && !(args.causeComment ?? "").trim()) {
    throw new Error("La cause « Autre » exige un commentaire.");
  }

  return {
    created: true,
    assessment,
    proposal: {
      ...args,
      referenceTime: args.referenceTime ?? null,
      variationPct: assessment.variationPct,
      outcome: assessment.outcome,
      reviewRequired: assessment.reviewRequired,
      causeComment: (args.causeComment ?? "").trim() || null,
    },
  };
}

/**
 * Libellé court destiné à la notification du planificateur.
 *
 * Le référentiel est facultatif : une notification ne doit pas échouer parce que
 * la table des familles n'a pas été jointe. Sans lui, `familyLabel` retombe sur
 * le libellé de repli, puis sur le code — jamais sur `undefined`.
 */
export function describeProposal(
  proposal: OfTimeVarianceProposal,
  referential?: readonly MachineFamilyRef[]
): string {
  const family = proposal.family ? ` (${familyLabel(proposal.family, referential)})` : "";
  const phase = `phase ${proposal.phase}${family}`;

  if (proposal.outcome === "REVUE") {
    return `${proposal.ofNumero} ${proposal.revisionCode} — ${phase} : temps de référence absent, revue obligatoire.`;
  }
  return `${proposal.ofNumero} ${proposal.revisionCode} — ${phase} : dérive de ${formatPct(
    proposal.variationPct ?? 0
  )}, replanification proposée.`;
}
