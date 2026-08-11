export const DIRECTION_DASHBOARD_CONTRACT_VERSION = "direction-dashboard/1.0" as const;
export const DIRECTION_DASHBOARD_TIMEZONE = "Europe/Paris" as const;

export const DIRECTION_KPI_DEFINITIONS = {
  otif: {
    label: "OTIF commandes",
    unit: "percent",
    formula:
      "100 × commandes intégralement expédiées à la date promise / commandes échues dont toutes les lignes ont une date promise",
    source: [
      "commande_client",
      "commande_ligne.delai_client",
      "bon_livraison",
      "bon_livraison_ligne",
    ],
    grain: "commande client",
  },
  at_risk_orders: {
    label: "Commandes à risque",
    unit: "count",
    formula:
      "commandes ouvertes avec retard, blocage workflow, OF en pause, fin OF postérieure au délai ou échéance sous 7 jours sans couverture stock/OF",
    source: [
      "commande_historique",
      "commande_ligne.delai_client",
      "ordres_fabrication",
      "stock_reservations",
      "bon_livraison",
    ],
    grain: "commande client ouverte",
  },
  overdue_value: {
    label: "Valeur en retard",
    unit: "currency",
    formula:
      "Σ quantité commandée non expédiée × prix HT × (1 − remise) pour les lignes dont le délai client est dépassé",
    source: [
      "commande_ligne.quantite",
      "commande_ligne.prix_unitaire_ht",
      "commande_ligne.remise_ligne",
      "commande_ligne.delai_client",
      "bon_livraison_ligne",
      "clients.devise",
    ],
    grain: "ligne de commande ouverte",
  },
  cash_30d: {
    label: "Cash attendu à 30 jours",
    unit: "currency",
    formula:
      "Σ soldes positifs des factures émises dont l'échéance explicite est comprise entre la date d'arrêté et J+30, nets des règlements et avoirs affectés",
    source: [
      "facture.date_echeance",
      "paiement_allocations",
      "avoir_source_allocations",
    ],
    grain: "facture émise",
  },
} as const;

export type DirectionReliability = "MEASURED" | "PARTIAL" | "UNAVAILABLE";

export function reliabilityFromCoverage(eligible: number, complete: number): DirectionReliability {
  if (eligible <= 0 || complete <= 0) return "UNAVAILABLE";
  return complete >= eligible ? "MEASURED" : "PARTIAL";
}

export type OtifLineFact = {
  promisedDate: string | null;
  orderedQuantity: number;
  completionDate: string | null;
};

/** Référence pure utilisée par les tests numériques et la requête SQL. */
export function evaluateOtifOrder(lines: readonly OtifLineFact[]): {
  eligible: boolean;
  onTimeInFull: boolean | null;
} {
  if (lines.length === 0 || lines.some((line) => !line.promisedDate || line.orderedQuantity <= 0)) {
    return { eligible: false, onTimeInFull: null };
  }
  return {
    eligible: true,
    onTimeInFull: lines.every(
      (line) => line.completionDate !== null && line.completionDate <= String(line.promisedDate)
    ),
  };
}
