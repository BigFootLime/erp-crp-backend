import { describe, it, expect } from "vitest";
import { normalizeDevisStatut, canTransitionDevisStatut, DEVIS_STATUTS } from "./status";

describe("devis statut enum (canonique partagé)", () => {
  it("normalise les alias FR (casse + accents) vers le canonique", () => {
    expect(normalizeDevisStatut("brouillon")).toBe("BROUILLON");
    expect(normalizeDevisStatut("Envoyé")).toBe("ENVOYE");
    expect(normalizeDevisStatut("accepté")).toBe("ACCEPTE");
    expect(normalizeDevisStatut("ACCEPTÉE")).toBe("ACCEPTE");
    expect(normalizeDevisStatut("refusé")).toBe("REFUSE");
    expect(normalizeDevisStatut("expiré")).toBe("EXPIRE");
    expect(normalizeDevisStatut("annulé")).toBe("ANNULE");
  });

  it("normalise les alias EN et les valeurs déjà canoniques", () => {
    expect(normalizeDevisStatut("draft")).toBe("BROUILLON");
    expect(normalizeDevisStatut("sent")).toBe("ENVOYE");
    expect(normalizeDevisStatut("BROUILLON")).toBe("BROUILLON");
    expect(normalizeDevisStatut("ENVOYE")).toBe("ENVOYE");
  });

  it("retombe sur BROUILLON pour vide/inconnu/null", () => {
    expect(normalizeDevisStatut("")).toBe("BROUILLON");
    expect(normalizeDevisStatut(null)).toBe("BROUILLON");
    expect(normalizeDevisStatut(undefined)).toBe("BROUILLON");
    expect(normalizeDevisStatut("xyz")).toBe("BROUILLON");
  });

  it("expose 6 statuts canoniques", () => {
    expect(DEVIS_STATUTS).toEqual(["BROUILLON", "ENVOYE", "ACCEPTE", "REFUSE", "EXPIRE", "ANNULE"]);
  });

  it("applique les transitions autorisées", () => {
    expect(canTransitionDevisStatut("BROUILLON", "ENVOYE")).toBe(true);
    expect(canTransitionDevisStatut("ENVOYE", "ACCEPTE")).toBe(true);
    expect(canTransitionDevisStatut("BROUILLON", "ACCEPTE")).toBe(false);
    expect(canTransitionDevisStatut("ANNULE", "BROUILLON")).toBe(false);
    expect(canTransitionDevisStatut("ACCEPTE", "ACCEPTE")).toBe(true);
  });
});
