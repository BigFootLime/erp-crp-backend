import { describe, expect, it } from "vitest";

import { createCommandeBodySchema } from "./commande-client.validators";

const ARTICLE = "11111111-1111-4111-8111-111111111111";
const PIECE = "22222222-2222-4222-8222-222222222222";
const VERSION = "33333333-3333-4333-8333-333333333333";

function payload() {
  return {
    order_type: "FERME",
    creation_flow_version: 2,
    save_intent: "VALIDATE" as const,
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

  it("accepts a commercially valid line without technical version", () => {
    const input = payload();
    input.lignes[0].piece_technique_version_id = undefined as unknown as string;
    expect(createCommandeBodySchema.safeParse(input).success).toBe(true);
  });

  it("accepts an incomplete server draft before reconciliation", () => {
    const input = { ...payload(), save_intent: "DRAFT" as const };
    input.lignes[0].piece_technique_version_id = undefined as unknown as string;
    input.lignes[0].reconciliation = undefined as unknown as ReturnType<typeof payload>["lignes"][number]["reconciliation"];
    expect(createCommandeBodySchema.safeParse(input).success).toBe(true);
  });

  it("accepts the structured quote technical draft without making it a commercial blocker", () => {
    const input = { ...payload(), save_intent: "DRAFT" as const };
    Object.assign(input.lignes[0], {
      technical_draft: {
        schema_version: 1,
        source: "DEVIS",
        source_devis_id: 12,
        source_dossier_id: null,
        completion_percent: 25,
        sections: {
          identity: { version: 1, values: { designation: { value: "Bride test", source: "DEVIS" } } },
          material: { version: 1, values: { matiere: { value: "42CD4", source: "DEVIS", needs_matching: true } } },
          bom: { version: 1, values: {} },
          routing: { version: 1, values: {} },
          operations: { version: 1, values: {} },
          treatments: { version: 1, values: {} },
          quality: { version: 1, values: {} },
          documents: { version: 1, values: {} },
        },
        unmapped: {},
      },
    });

    expect(createCommandeBodySchema.safeParse(input).success).toBe(true);
  });

  it("rejects a line whose comparison is not resolved", () => {
    const input = payload();
    input.lignes[0].reconciliation.status = "PENDING";
    expect(createCommandeBodySchema.safeParse(input).success).toBe(false);
  });
});
