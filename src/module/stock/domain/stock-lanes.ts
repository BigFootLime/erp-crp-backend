export const STOCK_LANES = ["FREE", "DELIVERY", "ASSEMBLY"] as const;
export type StockLane = (typeof STOCK_LANES)[number];

export const STOCK_LANE_LABELS: Record<StockLane, string> = {
  FREE: "Stock libre",
  DELIVERY: "Attente de livraison",
  ASSEMBLY: "Piste assemblage",
};

export type StockLaneLocationFacts = {
  active: boolean;
  mapped: boolean;
  storage: boolean;
  inbound: boolean;
  outbound: boolean;
  previousLane: StockLane | null;
  hasStock: boolean;
  hasReservations: boolean;
  hasDeliveryOrAssemblyReservations: boolean;
};

/** Configuration never moves a balance or changes ownership of reserved parts. */
export function stockLaneConfigurationBlockers(facts: StockLaneLocationFacts, lane: StockLane): string[] {
  const blockers: string[] = [];
  if (!facts.active) blockers.push("LOCATION_INACTIVE");
  if (!facts.mapped) blockers.push("LOCATION_NOT_MAPPED");
  if (!facts.storage || !facts.inbound || !facts.outbound) blockers.push("LOCATION_NOT_STORAGE");
  const occupied = facts.hasStock || facts.hasReservations;
  if (facts.previousLane && facts.previousLane !== lane && occupied) blockers.push("LANE_LOCATION_OCCUPIED");
  if (!facts.previousLane && occupied && (lane !== "FREE" || facts.hasDeliveryOrAssemblyReservations))
    blockers.push("LANE_INITIAL_CLASSIFICATION_REQUIRED");
  return blockers;
}

export const STOCK_LANE_BLOCKER_MESSAGES: Record<string, string> = {
  LOCATION_INACTIVE: "Activez le magasin et l’emplacement.",
  LOCATION_NOT_MAPPED: "Reliez l’emplacement à une localisation de stock.",
  LOCATION_NOT_STORAGE: "Choisissez un emplacement de stockage autorisant les entrées et sorties.",
  LANE_LOCATION_OCCUPIED: "Transférez les pièces et leurs réservations avant de changer le rôle de cet emplacement.",
  LANE_INITIAL_CLASSIFICATION_REQUIRED: "Cet emplacement contient des pièces à répartir. Configurez des pistes vides puis préparez leur transfert.",
};
