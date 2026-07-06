import { describe, it, expect } from "vitest";
import { computeLineTotals, computeDevisTotals } from "./totals";

describe("devis totals (recalcul serveur — ISO A.8.28)", () => {
  it("calcule HT/TVA/TTC d'une ligne simple", () => {
    expect(computeLineTotals({ quantite: 2, prix_unitaire_ht: 10, taux_tva: 20 })).toEqual({
      total_ht: 20,
      total_tva: 4,
      total_ttc: 24,
    });
  });

  it("arrondit à 2 décimales", () => {
    const t = computeLineTotals({ quantite: 3, prix_unitaire_ht: 9.99, taux_tva: 20 });
    expect(t.total_ht).toBe(29.97);
    expect(t.total_ttc).toBe(35.96);
  });

  it("applique la remise de ligne (clampée 0..100)", () => {
    expect(computeLineTotals({ quantite: 1, prix_unitaire_ht: 100, remise_ligne: 10, taux_tva: 0 }).total_ht).toBe(90);
    // remise > 100 -> clamp à 100 -> HT 0
    expect(computeLineTotals({ quantite: 1, prix_unitaire_ht: 100, remise_ligne: 150 }).total_ht).toBe(0);
  });

  it("interdit un HT négatif (prix négatif -> 0)", () => {
    expect(computeLineTotals({ quantite: 1, prix_unitaire_ht: -50, taux_tva: 20 }).total_ht).toBe(0);
  });

  it("gère un devis vide", () => {
    expect(computeDevisTotals([], 0)).toMatchObject({ total_ht: 0, total_ttc: 0, total_tva: 0 });
  });

  it("applique la remise globale sur le sous-total", () => {
    const lines = [
      { quantite: 1, prix_unitaire_ht: 100, taux_tva: 20 },
      { quantite: 1, prix_unitaire_ht: 100, taux_tva: 20 },
    ];
    const t = computeDevisTotals(lines, 10);
    expect(t.subtotal_ht).toBe(200);
    expect(t.total_ht).toBe(180);
    expect(t.total_ttc).toBe(216);
    expect(t.remise_pct).toBe(10);
  });

  it("gère des taux de TVA mixtes", () => {
    const t = computeDevisTotals(
      [
        { quantite: 1, prix_unitaire_ht: 100, taux_tva: 20 },
        { quantite: 1, prix_unitaire_ht: 100, taux_tva: 5.5 },
      ],
      0
    );
    expect(t.total_ht).toBe(200);
    expect(t.total_ttc).toBe(225.5);
  });
});
