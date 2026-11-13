import { describe, expect, it } from "vitest";

import { outilUpsertSchema } from "./outil.validator";

const validTool = {
  id_fabricant: 1,
  id_famille: 1,
  codification: "FRAISA-S-123",
  designation_outil_cnc: "Fraise S-123",
  fournisseurs: [],
  revetements: [],
  valeurs_aretes: [],
  catalogue_source: { selection_id: "source-1", reference_confirmed: true },
};

describe("catalogue-origin tool validation", () => {
  it("rejects a claimed physical balance while allowing an explicit reorder threshold", () => {
    expect(outilUpsertSchema.safeParse({ ...validTool, quantite_stock: 1, quantite_minimale: 2 }).success).toBe(false);
    expect(outilUpsertSchema.safeParse({ ...validTool, quantite_stock: 0, quantite_minimale: 2 }).success).toBe(true);
  });

  it("requires an explicit true reference confirmation", () => {
    expect(outilUpsertSchema.safeParse({ ...validTool, catalogue_source: { selection_id: "source-1", reference_confirmed: false } }).success).toBe(false);
  });
});
