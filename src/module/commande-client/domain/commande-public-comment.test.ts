import { describe, expect, it } from "vitest";
import { customerCommandeComment } from "./commande-public-comment";

describe("customer-facing order comments", () => {
  it.each([null, undefined, "", "   \n"])("omits empty comment %s", value => {
    expect(customerCommandeComment(value)).toBeNull();
  });
  it("preserves ordinary customer notes, including multiline text", () => {
    expect(customerCommandeComment("  Livraison quai 2.\nPrévenir à l’arrivée.  ")).toBe("Livraison quai 2.\nPrévenir à l’arrivée.");
  });
  it("removes priority-only operational storage", () => {
    expect(customerCommandeComment("[Commande operations]\nPriorite: CRITIQUE\n[/Commande operations]")).toBeNull();
  });
  it("keeps public notes before and after the block and meaningful constraints", () => {
    expect(customerCommandeComment("Note client.\n\n[Commande operations]\nPriorite: HAUTE\nContraintes client: Certificat MP obligatoire.\nContrôle 100 %.\n[/Commande operations]\nAprès contrôle."))
      .toBe("Note client.\n\n\nAprès contrôle.\n\nExigences client :\nCertificat MP obligatoire.\nContrôle 100 %.");
  });
  it("supports CRLF and repeated blocks without repeating identical constraints", () => {
    const block = "[Commande operations]\r\nPriorite: NORMALE\r\nContraintes client: Livraison partielle interdite.\r\n[/Commande operations]";
    expect(customerCommandeComment(block + "\r\n" + block)).toBe("Exigences client :\nLivraison partielle interdite.");
  });
  it("does not expose an incomplete operational block", () => {
    expect(customerCommandeComment("Note publique.\n[Commande operations]\nPriorite: CRITIQUE\nContraintes client: Texte non délimité"))
      .toBe("Note publique.");
  });
  it("does not remove words that are part of ordinary public prose", () => {
    expect(customerCommandeComment("Priorité de livraison convenue : quai 3. Contraintes client: hauteur 2 m."))
      .toBe("Priorité de livraison convenue : quai 3. Contraintes client: hauteur 2 m.");
  });
});
