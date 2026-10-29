import { describe, expect, it } from "vitest";
import { ofDocumentMaterialCutting } from "./of-document-technical-source";

describe("OF material cutting evidence", () => {
  it("uses whole raw blanks for a frozen PT yield", () => {
    expect(ofDocumentMaterialCutting({ longueur_mm: 100, quantite_pieces: 2 }, 101)).toEqual({
      longueurCoupeMm: 100, piecesParBrut: 2, brutsParPiece: .5, nombreBruts: 51, longueurTotaleMm: 5100,
    });
  });
  it("supports a canonical fractional yield for several raw blanks per part", () => {
    expect(ofDocumentMaterialCutting({ longueur_mm: 100, quantite_pieces: 1 / 3 }, 101)?.nombreBruts).toBe(303);
  });
});
