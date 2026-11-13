import { describe, expect, it } from "vitest";

import {
  updateAchatSchema,
  updateBomLineSchema,
  updateOperationSchema,
} from "./pieces-techniques.validators";

describe("pièces techniques — PATCH sans défauts de création", () => {
  it("ne réintroduit pas les quantités ni les valeurs d'opération omises", () => {
    expect(updateBomLineSchema.parse({ body: { repere: "R1" } }).body).toEqual({ repere: "R1" });
    expect(updateOperationSchema.parse({ body: { designation: "Finition" } }).body).toEqual({ designation: "Finition" });
    expect(updateAchatSchema.parse({ body: { nom: "Vis M6" } }).body).toEqual({ nom: "Vis M6" });
  });

  it("conserve les modifications explicites aux anciennes valeurs par défaut", () => {
    expect(updateBomLineSchema.parse({ body: { quantite: 1 } }).body.quantite).toBe(1);
    expect(updateOperationSchema.parse({ body: { phase: 10, prix: 0, coef: 1, qte: 1 } }).body).toMatchObject({
      phase: 10,
      prix: 0,
      coef: 1,
      qte: 1,
    });
    expect(updateAchatSchema.parse({ body: { type_achat: "DIVERS", quantite: 1, tva_achat: 20 } }).body).toMatchObject({
      type_achat: "DIVERS",
      quantite: 1,
      tva_achat: 20,
    });
  });
});
