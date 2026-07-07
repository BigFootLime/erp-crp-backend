// Statuts devis — enum canonique partagé (source de vérité backend).
// Le frontend (src/modules/devis/lib/devis-ui.ts) reflète les mêmes valeurs + libellés.
// ISO/IEC 27001 A.8.28 (codage sécurisé) / A.5.12 (classification) : statut contrôlé, non texte libre.

export const DEVIS_STATUTS = ["BROUILLON", "ENVOYE", "ACCEPTE", "REFUSE", "EXPIRE", "ANNULE"] as const;
export type DevisStatut = (typeof DEVIS_STATUTS)[number];

export const DEVIS_STATUT_DEFAULT: DevisStatut = "BROUILLON";

export const DEVIS_STATUT_LABELS: Record<DevisStatut, string> = {
  BROUILLON: "Brouillon",
  ENVOYE: "Envoyé",
  ACCEPTE: "Accepté",
  REFUSE: "Refusé",
  EXPIRE: "Expiré",
  ANNULE: "Annulé",
};

function stripAccentsLower(value: string): string {
  try {
    return value.trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  } catch {
    return value.trim().toLowerCase();
  }
}

/**
 * Normalise n'importe quelle entrée (casse, accents, alias FR/EN) vers un statut canonique.
 * Valeur inconnue/vide -> BROUILLON (défaut sûr).
 */
export function normalizeDevisStatut(input: unknown): DevisStatut {
  const raw = typeof input === "string" ? input : input == null ? "" : String(input);
  const s = stripAccentsLower(raw);
  switch (s) {
    case "":
    case "brouillon":
    case "draft":
      return "BROUILLON";
    case "envoye":
    case "sent":
    case "a_relancer":
      return "ENVOYE";
    case "accepte":
    case "acceptee":
    case "accepted":
      return "ACCEPTE";
    case "refuse":
    case "refusee":
    case "rejected":
      return "REFUSE";
    case "expire":
    case "expiree":
    case "expired":
      return "EXPIRE";
    case "annule":
    case "annulee":
    case "cancelled":
    case "canceled":
      return "ANNULE";
    default: {
      const upper = raw.trim().toUpperCase();
      return (DEVIS_STATUTS as readonly string[]).includes(upper) ? (upper as DevisStatut) : "BROUILLON";
    }
  }
}

// Transitions métier autorisées.
export const DEVIS_STATUT_TRANSITIONS: Record<DevisStatut, readonly DevisStatut[]> = {
  BROUILLON: ["ENVOYE", "ANNULE"],
  ENVOYE: ["ACCEPTE", "REFUSE", "EXPIRE", "ANNULE"],
  ACCEPTE: ["ANNULE"],
  REFUSE: ["BROUILLON", "ANNULE"],
  EXPIRE: ["BROUILLON", "ENVOYE", "ANNULE"],
  ANNULE: [],
};

export function canTransitionDevisStatut(from: DevisStatut, to: DevisStatut): boolean {
  if (from === to) return true;
  return DEVIS_STATUT_TRANSITIONS[from].includes(to);
}
