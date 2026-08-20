export type CommercialReferenceAvailability = "NOT_CONFIGURED";

/** Mirrors the existing frontend option shape without inventing a row. */
export type ConditionsPaiementResponse = {
  items: Array<{ id: number; code: string; libelle: string }>;
  availability: CommercialReferenceAvailability;
  message: string;
  source: null;
  freshness_at: null;
  reliability: "UNAVAILABLE";
};

/** Kept distinct because the existing UI uses legacy Compte_Vente field names. */
export type ComptesVenteResponse = {
  items: Array<{ seller_account_id: string; label: string; account: string }>;
  availability: CommercialReferenceAvailability;
  message: string;
  source: null;
  freshness_at: null;
  reliability: "UNAVAILABLE";
};

/**
 * Aucun modèle métier versionné de conditions de paiement n'existe dans ce
 * dépôt. Le contrat explicite évite de fabriquer un référentiel financier ou
 * de présenter des valeurs de démonstration comme des données réelles.
 */
export async function repoListConditionsPaiement(): Promise<ConditionsPaiementResponse> {
  return {
    items: [],
    availability: "NOT_CONFIGURED",
    message: "Les conditions de paiement ne sont pas encore configurées.",
    source: null,
    freshness_at: null,
    reliability: "UNAVAILABLE",
  };
}

/** Same explicit contract for the ungoverned historic Compte_Vente shape. */
export async function repoListComptesVente(): Promise<ComptesVenteResponse> {
  return {
    items: [],
    availability: "NOT_CONFIGURED",
    message: "Les comptes de vente ne sont pas encore configurés.",
    source: null,
    freshness_at: null,
    reliability: "UNAVAILABLE",
  };
}
