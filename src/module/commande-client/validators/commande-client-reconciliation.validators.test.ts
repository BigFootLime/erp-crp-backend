import { describe, expect, it } from "vitest";

import { createCommandeBodySchema } from "./commande-client.validators";

const ARTICLE = "11111111-1111-4111-8111-111111111111";
const PIECE = "22222222-2222-4222-8222-222222222222";
const VERSION = "33333333-3333-4333-8333-333333333333";

function payload() {
  return {
    order_type: "FERME",
    creation_flow_version: 2,
    client_id: "001",
    code_client: "PO-TEST-698",
    devis_id: 12,
    date_commande: "2026-09-03",
    lignes: [
      {
        article_id: ARTICLE,
        piece_technique_id: PIECE,
        piece_technique_version_id: VERSION,
        source_devis_ligne_id: 34,
        designation: "Bride test",
        quantite: 10,
        unite: "u",
        prix_unitaire_ht: 42,
        delai_client: "2026-10-01",
        reconciliation: {
          status: "RESOLVED",
          sources: {
            selected: {
              article_id: ARTICLE,
              piece_technique_id: PIECE,
              piece_technique_version_id: VERSION,
              designation: "Bride test",
              quantite: 10,
              unite: "u",
              prix_unitaire_ht: 42,
              delai_client: "2026-10-01",
            },
          },
          decisions: {
            designation: "ORDER",
            quantite: "ORDER",
            unite: "CERP",
            prix_unitaire_ht: "QUOTE",
            delai_client: "ORDER",
            piece_technique_version_id: "CERP",
          },
        },
      },
    ],
  };
}

describe("createCommandeBodySchema — reconciled customer order", () => {
  it("accepts a fully arbitrated line with its pinned technical version", () => {
    expect(createCommandeBodySchema.safeParse(payload()).success).toBe(true);
  });

  it("rejects a line without technical version", () => {
    const input = payload();
    input.lignes[0].piece_technique_version_id = undefined as unknown as string;
    const result = createCommandeBodySchema.safeParse(input);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.join(".") === "lignes.0.piece_technique_version_id")).toBe(true);
    }
  });

  it("rejects a line whose comparison is not resolved", () => {
    const input = payload();
    input.lignes[0].reconciliation.status = "PENDING";
    expect(createCommandeBodySchema.safeParse(input).success).toBe(false);
  });
});
