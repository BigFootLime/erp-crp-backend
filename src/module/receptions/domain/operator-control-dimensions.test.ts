import { describe, expect, it } from "vitest";
import { applyOperatorRequirements, operatorMaterialDimensions } from "./operator-control-dimensions";
import { operatorControlSchema } from "../validators/receipt-processing.validators";

describe("dimensions du contrôle opérateur MP", () => {
  it("propose la longueur source et le diamètre d'un rond selon la référence et ses minima d'achat", () => {
    const dimensions = operatorMaterialDimensions({ profile: "ROND", barToCut: true, sourceLengthMm: 3020, cutLengthMm: 1000, diameterMm: 22 });
    const specifications = ["304L", "diametre_mm: 22 mm minimum", "longueur_mm : 1000 mm minimum"]
      .map(valeur => ({ type: "SPECIFICATION", valeur, obligatoire: true }));

    expect(applyOperatorRequirements(dimensions, "304L", specifications)).toEqual([
      { label: "Longueur", valueMm: 3020, minimumMm: 1000 },
      { label: "Diamètre", valueMm: 22, minimumMm: 22 },
    ]);
  });

  it("exige les cotes de la forme même si une référence est inconnue", () => {
    expect(operatorMaterialDimensions({ profile: "PL", widthMm: 80, lengthMm: 1000 })).toEqual([
      { label: "Longueur", valueMm: 1000 }, { label: "Largeur", valueMm: 80 }, { label: "Épaisseur", valueMm: null },
    ]);
    expect(operatorMaterialDimensions()).toEqual([{ label: "Longueur", valueMm: null }]);
  });

  it.each([
    { type: "SPECIFICATION", valeur: "316L", obligatoire: true },
    { type: "SPECIFICATION", valeur: "Certificat EN 10204 3.1", obligatoire: true },
    { type: "SPECIFICATION", valeur: "largeur_mm : 80 mm minimum", obligatoire: true },
    { type: "CERTIFICAT_MATIERE", obligatoire: true },
    { type: "LOT", obligatoire: true },
    { type: "COULEE", obligatoire: true },
    { type: "AUTRE", valeur: "Contrôle de dureté", obligatoire: true },
  ])("laisse l'exigence obligatoire ininterprétable au contrôle formel : %o", requirement => {
    expect(applyOperatorRequirements(operatorMaterialDimensions({ profile: "RO" }), "304L", [requirement])).toBeNull();
  });

  it("refuse l'enregistrement si une cote ou une nuance n'est pas confirmée", () => {
    const payload = {
      idempotencyKey: "98b3cc21-e9c6-4b5d-8a7d-c47a0ea969db", expectedVersion: 1,
      kind: "MP", verdict: "CONFORME", grade: { value: "304L", confirmed: true },
      measurements: [{ label: "Longueur", valueMm: 3020, confirmed: true }],
    };
    expect(operatorControlSchema.safeParse(payload).success).toBe(true);
    expect(operatorControlSchema.safeParse({ ...payload, measurements: [{ ...payload.measurements[0], confirmed: false }] }).success).toBe(false);
    expect(operatorControlSchema.safeParse({ ...payload, grade: { value: "304L", confirmed: false } }).success).toBe(false);
    expect(operatorControlSchema.safeParse({ ...payload, kind: "PART" }).success).toBe(false);
  });
});
