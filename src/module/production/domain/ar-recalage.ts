// Dossier d'AR client à recaler.
//
// Après validation d'un planning : sans impact client, on publie sans AR ; si un
// délai ou une cadence accusés sont dépassés, on ouvre un dossier de recalage.
//
// Le dossier est **interne**. Rien ne part chez le client automatiquement : ni
// e-mail, ni accusé de réception rectificatif. Reprendre contact avec un client
// pour décaler un engagement est un acte commercial, pas un effet de bord d'un
// calcul de planning.
//
// À ne pas confondre avec `commande_ar_log`, qui journalise l'AR **envoyé** à la
// confirmation de commande.

import type { OfClientImpact, OfPlanningComparison } from "./of-planning-version";

export const AR_RECALAGE_MOTIFS = [
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
export type ArRecalageMotif = (typeof AR_RECALAGE_MOTIFS)[number];

export const AR_RECALAGE_MOTIF_LABELS: Record<ArRecalageMotif, string> = {
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

export function isArRecalageMotif(value: unknown): value is ArRecalageMotif {
  return typeof value === "string" && (AR_RECALAGE_MOTIFS as readonly string[]).includes(value);
}

export const AR_RECALAGE_STATUTS = ["A_TRAITER", "EN_COURS", "RECALE", "ABANDONNE"] as const;
export type ArRecalageStatut = (typeof AR_RECALAGE_STATUTS)[number];

export const AR_RECALAGE_STATUT_LABELS: Record<ArRecalageStatut, string> = {
  A_TRAITER: "À traiter",
  EN_COURS: "En cours",
  RECALE: "Recalé",
  ABANDONNE: "Abandonné",
};

export const AR_RECALAGE_TRANSITIONS: Record<ArRecalageStatut, readonly ArRecalageStatut[]> = {
  A_TRAITER: ["EN_COURS", "ABANDONNE"],
  EN_COURS: ["RECALE", "ABANDONNE", "A_TRAITER"],
  RECALE: [],
  ABANDONNE: [],
};

export function canTransitionArStatut(from: ArRecalageStatut, to: ArRecalageStatut): boolean {
  if (from === to) return true;
  return AR_RECALAGE_TRANSITIONS[from].includes(to);
}

export type ArCadence = Array<{ date: string; quantite: number }>;

export type ArRecalageDossier = {
  clientId: string | null;
  clientNom: string | null;
  commandeId: number | null;
  commandeNumero: string | null;
  affaireId: number | null;
  affaireNumero: string | null;
  ofId: number;
  ofNumero: string;
  planningVersionId: string | null;
  previousDate: string | null;
  previousCadence: ArCadence | null;
  newDate: string | null;
  newCadence: ArCadence | null;
  quantite: number | null;
  motif: ArRecalageMotif;
  commentaire: string | null;
  statut: ArRecalageStatut;
  ownerUserId: number | null;
};

export type ArRecalageValidation =
  | { valid: true }
  | { valid: false; code: string; message: string };

/**
 * « Autre » impose un commentaire.
 *
 * Un motif fourre-tout sans explication rend le dossier illisible pour la personne
 * qui devra appeler le client : elle saurait qu'il faut recaler, pas quoi dire.
 */
export function validateArRecalageInput(args: {
  motif: unknown;
  commentaire: string | null | undefined;
}): ArRecalageValidation {
  if (!isArRecalageMotif(args.motif)) {
    return { valid: false, code: "MOTIF_INVALIDE", message: "Motif de recalage inconnu." };
  }
  const commentaire = (args.commentaire ?? "").trim();
  if (args.motif === "AUTRE" && !commentaire) {
    return {
      valid: false,
      code: "COMMENTAIRE_REQUIS",
      message: "Le motif « Autre » exige un commentaire.",
    };
  }
  return { valid: true };
}

/**
 * Affaires de livraison réellement touchées : celles dont l'engagement est
 * dépassé, plus celles dont une échéance de cadence a bougé.
 *
 * Une échéance de cadence sans affaire rattachée (`affaireId` nul) concerne tout
 * l'OF : faute de pouvoir la cibler, elle touche chaque affaire livrée par cet OF.
 */
function affectedAffaireIds(comparison: OfPlanningComparison): Set<number> {
  const touched = new Set<number>();
  for (const engagement of comparison.engagements) {
    if (engagement.depasse) touched.add(engagement.affaireId);
  }
  for (const echeance of comparison.cadence) {
    if (echeance.affaireId !== null) {
      touched.add(echeance.affaireId);
    } else {
      for (const engagement of comparison.engagements) touched.add(engagement.affaireId);
    }
  }
  return touched;
}

export type ArRecalageDecision =
  | { required: false; reason: string }
  | { required: true; impact: OfClientImpact; reason: string; affaireIds: number[] };

/**
 * Décide, à partir de la comparaison de planning, s'il faut ouvrir un dossier.
 *
 * Sans impact client : on publie, et on n'ouvre rien. Ouvrir un dossier vide
 * habituerait l'administration des ventes à les fermer sans les lire.
 */
export function decideArRecalage(comparison: OfPlanningComparison): ArRecalageDecision {
  if (comparison.clientImpact === "AUCUN") {
    return {
      required: false,
      reason: "Aucun engagement client dépassé et cadence inchangée : publication sans AR.",
    };
  }

  const affaireIds = [...affectedAffaireIds(comparison)].sort((a, b) => a - b);

  const parts: string[] = [];
  if (comparison.summary.engagementsDepasses > 0) {
    parts.push(
      `${comparison.summary.engagementsDepasses} engagement(s) client dépassé(s)`
    );
  }
  if (comparison.summary.cadenceModifiee) parts.push("cadence de livraison modifiée");

  return {
    required: true,
    impact: comparison.clientImpact,
    reason: `${parts.join(" et ")} : dossier d'AR à recaler.`,
    affaireIds,
  };
}

/**
 * Construit les dossiers à ouvrir, un par affaire de livraison concernée.
 *
 * Un dossier par affaire et non un dossier global : chaque affaire porte son
 * propre engagement, sa propre quantité et sera recalée séparément avec le client.
 */
export function buildArRecalageDossiers(args: {
  comparison: OfPlanningComparison;
  ofId: number;
  ofNumero: string;
  planningVersionId: string | null;
  motif: ArRecalageMotif;
  commentaire: string | null;
  ownerUserId: number | null;
  clientNomByClientId?: Record<string, string | null>;
  commandeNumeroById?: Record<number, string | null>;
  previousCadenceByAffaire?: Record<number, ArCadence | null>;
  newCadenceByAffaire?: Record<number, ArCadence | null>;
  quantiteByAffaire?: Record<number, number | null>;
}): ArRecalageDossier[] {
  const decision = decideArRecalage(args.comparison);
  if (!decision.required) return [];

  const validation = validateArRecalageInput({
    motif: args.motif,
    commentaire: args.commentaire,
  });
  if (!validation.valid) throw new Error(validation.message);

  const touched = affectedAffaireIds(args.comparison);

  return args.comparison.engagements
    .filter((engagement) => touched.has(engagement.affaireId))
    .map<ArRecalageDossier>((engagement) => ({
      clientId: engagement.clientId,
      clientNom: engagement.clientId
        ? (args.clientNomByClientId?.[engagement.clientId] ?? null)
        : null,
      commandeId: engagement.commandeId,
      commandeNumero: engagement.commandeId
        ? (args.commandeNumeroById?.[engagement.commandeId] ?? null)
        : null,
      affaireId: engagement.affaireId,
      affaireNumero: engagement.affaireNumero,
      ofId: args.ofId,
      ofNumero: args.ofNumero,
      planningVersionId: args.planningVersionId,
      previousDate: engagement.delaiClient,
      previousCadence: args.previousCadenceByAffaire?.[engagement.affaireId] ?? null,
      newDate: engagement.nouvelleDate,
      newCadence: args.newCadenceByAffaire?.[engagement.affaireId] ?? null,
      quantite: args.quantiteByAffaire?.[engagement.affaireId] ?? null,
      motif: args.motif,
      commentaire: (args.commentaire ?? "").trim() || null,
      statut: "A_TRAITER",
      ownerUserId: args.ownerUserId,
    }))
    .sort((a, b) => (a.affaireId ?? 0) - (b.affaireId ?? 0));
}

/** Résumé destiné à la notification interne. Jamais envoyé au client. */
export function describeArRecalage(dossier: ArRecalageDossier): string {
  const client = dossier.clientNom ?? dossier.clientId ?? "client non renseigné";
  const commande = dossier.commandeNumero ? ` commande ${dossier.commandeNumero}` : "";
  const affaire = dossier.affaireNumero ? ` affaire ${dossier.affaireNumero}` : "";
  const dates =
    dossier.previousDate && dossier.newDate
      ? ` : ${formatDateFr(dossier.previousDate)} -> ${formatDateFr(dossier.newDate)}`
      : "";
  return `AR à recaler — ${client}${commande}${affaire}${dates} (${AR_RECALAGE_MOTIF_LABELS[dossier.motif]}).`;
}

function formatDateFr(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}
