import { describe, expect, it } from "vitest";
import { materialRequirementForPieces } from "./of-material";
import { proposeMaterialConfiguration } from "./material-configuration-proposal";

describe("material cutting proposal", () => {
  it("keeps a physical 100 mm blank and rounds 101 finished pieces to 51 blanks before confirmation", () => {
    const proposal = proposeMaterialConfiguration(
      { quantite: .5, unite_prix: "mm", longueur_mm: 100, quantite_pieces: 2 },
      { id: "article", code: "MP-CUT", unite: "mm", client_proprietaire_id: null, grade: null, condition: null, sub_condition: null, longueur_mm: null, longueur_brut_mm: null, diametre_mm: null, largeur_mm: null, epaisseur_mm: null },
      [], null,
    );
    expect(proposal.debitRule).toMatchObject({ form: "BAR", unitsPerBlank: 100, piecesPerBlank: 2 });
    expect(materialRequirementForPieces(proposal.debitRule!, 101)).toBe(5100);
  });
});
