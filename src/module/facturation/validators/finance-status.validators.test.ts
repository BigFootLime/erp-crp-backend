import { describe, expect, it } from "vitest";

import { createAvoirBodySchema, updateAvoirBodySchema } from "./avoirs.validators";
import { createFactureBodySchema, updateFactureBodySchema } from "./factures.validators";

const invoiceDraft = {
  client_id: "CLIENT-1",
  lignes: [{ designation: "Prestation", prix_unitaire_ht: "100.00" }],
};
const creditDraft = {
  client_id: "CLIENT-1",
  lignes: [{ designation: "Correction", prix_unitaire_ht: "10.00" }],
};

describe("#469 finance write status validation", () => {
  it("defaults legacy create payloads to the canonical draft status", () => {
    expect(createFactureBodySchema.parse(invoiceDraft).statut).toBe("DRAFT");
    expect(createAvoirBodySchema.parse(creditDraft).statut).toBe("DRAFT");
  });

  it.each(["custom", "paid", "ISSUED", "PARTIALLY_PAID", "CANCELLED"])(
    "rejects invoice status %s on generic writes",
    (statut) => {
      expect(createFactureBodySchema.safeParse({ ...invoiceDraft, statut }).success).toBe(false);
      expect(updateFactureBodySchema.safeParse({ statut }).success).toBe(false);
    }
  );

  it.each(["custom", "issued", "ISSUED", "CANCELLED"])(
    "rejects credit-note status %s on generic writes",
    (statut) => {
      expect(createAvoirBodySchema.safeParse({ ...creditDraft, statut }).success).toBe(false);
      expect(updateAvoirBodySchema.safeParse({ statut }).success).toBe(false);
    }
  );
});
