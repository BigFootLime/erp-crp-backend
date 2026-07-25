// Analyse d'impact métrologique (#229) — bornage pur, sans I/O.
//
// Un instrument déclaré hors tolérance jette un doute sur les mesures qu'il a
// produites DEPUIS la dernière preuve conforme admissible. Ce fichier calcule
// cette fenêtre et rien d'autre.
//
// Ce que l'analyse N'EST PAS :
//   * une présomption de non-conformité produit ;
//   * une recherche non bornée dans tout l'historique ;
//   * un déclencheur d'action automatique. Aucun contrôle n'est annulé, aucun
//     lot déstocké, aucun BL annulé, aucun avoir créé, aucune expédition
//     bloquée et aucun rappel client lancé par ce module.

import { HttpError } from "../../../utils/httpError";

export type ImpactTrigger = "VERDICT_NON_CONFORME" | "CERTIFICAT_INVALIDE" | "MANUEL";
export type ImpactWindowSource = "LAST_CONFORME_PROOF" | "APPROVED_WINDOW" | "EQUIPMENT_CREATION";

export type ImpactWindowInput = {
  trigger: ImpactTrigger;
  /** Fin de fenêtre : l'événement déclenchant (verdict, invalidation). */
  eventAt: Date;
  /** Dernière preuve conforme admissible connue. */
  lastConformeProofAt: Date | null;
  /** Repli : création de l'équipement, quand aucune preuve conforme n'existe. */
  equipmentCreatedAt: Date;
  /** Fenêtre explicitement approuvée par un humain (remplace le calcul). */
  approvedFrom?: Date | null;
  approvedTo?: Date | null;
  approvedReason?: string | null;
};

export type ImpactWindow = {
  from: Date;
  to: Date;
  source: ImpactWindowSource;
  /** Explication affichable : l'analyse doit être auditable sans lire le code. */
  method: string;
  span_days: number;
};

/** Garde-fou : une fenêtre d'analyse reste bornée, jamais « tout l'historique ». */
const MAX_WINDOW_DAYS = 1826; // 5 ans

export function computeImpactWindow(input: ImpactWindowInput): ImpactWindow {
  const to = input.eventAt;

  if (input.approvedFrom && input.approvedTo) {
    if (input.approvedTo < input.approvedFrom) {
      throw new HttpError(
        422,
        "METROLOGY_IMPACT_WINDOW_INVALID",
        "La fenêtre approuvée se termine avant de commencer."
      );
    }
    if ((input.approvedReason ?? "").trim().length < 20) {
      throw new HttpError(
        422,
        "METROLOGY_IMPACT_WINDOW_JUSTIFICATION_REQUIRED",
        "Une fenêtre d'analyse imposée exige une justification d'au moins 20 caractères."
      );
    }
    const span = spanDays(input.approvedFrom, input.approvedTo);
    assertBounded(span);
    return {
      from: input.approvedFrom,
      to: input.approvedTo,
      source: "APPROVED_WINDOW",
      method: `Fenêtre approuvée manuellement (${span} j) : ${(input.approvedReason ?? "").trim()}`,
      span_days: span,
    };
  }

  if (input.lastConformeProofAt && input.lastConformeProofAt <= to) {
    const span = spanDays(input.lastConformeProofAt, to);
    assertBounded(span);
    return {
      from: input.lastConformeProofAt,
      to,
      source: "LAST_CONFORME_PROOF",
      method:
        "Usages de l'instrument depuis la dernière preuve conforme admissible jusqu'à l'événement déclenchant.",
      span_days: span,
    };
  }

  // Aucune preuve conforme : le doute remonte à la mise en service. On borne
  // quand même, et on le dit explicitement dans la méthode.
  const from = input.equipmentCreatedAt <= to ? input.equipmentCreatedAt : to;
  const span = spanDays(from, to);
  assertBounded(span);
  return {
    from,
    to,
    source: "EQUIPMENT_CREATION",
    method:
      "Aucune preuve conforme antérieure : la fenêtre remonte à l'entrée de l'instrument au registre.",
    span_days: span,
  };
}

function spanDays(from: Date, to: Date): number {
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  return Math.max(0, Math.ceil((to.getTime() - from.getTime()) / MS_PER_DAY));
}

function assertBounded(span: number): void {
  if (span > MAX_WINDOW_DAYS) {
    throw new HttpError(
      422,
      "METROLOGY_IMPACT_WINDOW_TOO_WIDE",
      `La fenêtre d'analyse dépasse ${MAX_WINDOW_DAYS} jours : approuvez explicitement une fenêtre restreinte.`,
      { span_days: span, max_days: MAX_WINDOW_DAYS }
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Priorité et volumétrie                                                     */
/* -------------------------------------------------------------------------- */

export type ImpactVolumes = {
  controls: number;
  work_orders: number;
  lots: number;
  deliveries: number;
  /** Vrai quand la liste a été tronquée par la borne dure de pagination. */
  truncated: boolean;
};

export type ImpactPriority = "LOW" | "NORMAL" | "HIGH" | "CRITICAL";

/**
 * Priorité proposée par le serveur. Elle oriente le travail humain ; elle ne
 * décide de rien et n'est jamais un verdict produit.
 */
export function suggestImpactPriority(params: {
  volumes: ImpactVolumes;
  criticite: string | null;
}): ImpactPriority {
  const critical = String(params.criticite ?? "").toUpperCase() === "CRITIQUE";
  // Une pièce déjà partie chez le client est ce qui coûte le plus cher à
  // rattraper : la présence de BL pèse plus lourd que le volume brut.
  if (params.volumes.deliveries > 0) return critical ? "CRITICAL" : "HIGH";
  if (critical && params.volumes.controls > 0) return "HIGH";
  if (params.volumes.controls === 0) return "LOW";
  if (params.volumes.controls > 50 || params.volumes.lots > 10) return "HIGH";
  return "NORMAL";
}

/* -------------------------------------------------------------------------- */
/* Borne dure de collecte                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Nombre maximum d'usages matérialisés dans un dossier. Au-delà, le dossier est
 * marqué `truncated` et le volume réel est conservé : une troncature silencieuse
 * se lirait comme « tout est couvert » alors que non.
 */
export const IMPACT_ITEM_HARD_LIMIT = 2000;

export function describeTruncation(collected: number, total: number): string | null {
  if (total <= collected) return null;
  return `Dossier tronqué : ${collected} usages matérialisés sur ${total} identifiés. Restreignez la fenêtre ou traitez par lots.`;
}
