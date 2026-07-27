import { describe, expect, it, vi } from "vitest";

const createCommandeFournisseurSVC = vi.hoisted(() => vi.fn());

vi.mock("../module/commande-fournisseur/services/commande-fournisseur.service", () => ({
  createCommandeFournisseurSVC,
}));

import { createImportTarget } from "../module/import-assistant/services/import-targets.service";

const audit = {
  user_id: 1,
  ip: null,
  user_agent: null,
  device_type: null,
  os: null,
  browser: null,
  path: "/api/v1/import-assistant/batches/batch/confirm",
  page_key: "import-assistant",
  client_session_id: null,
};

describe("Cible import commande fournisseur", () => {
  it("injecte le fournisseur rapproché, l'idempotence et laisse la commande en brouillon", async () => {
    createCommandeFournisseurSVC.mockResolvedValue({
      id: "3b9e2a31-6513-4b9c-a0df-df01a86e74cc",
      code: "BCF-2026-0042",
      idempotent_replay: false,
    });

    const result = await createImportTarget({
      entity_type: "FOURNISSEUR_COMMANDE",
      normalized_data: {
        fournisseur_legacy_code: "F272",
        date_commande_source: "2026-07-22",
        origine: "MANUEL",
        devise: "EUR",
        frais_port_ht: 0,
        tva_frais_pct: 20,
        note_interne: "Migration CLIPPER — BC 4542 du 2026-07-22",
        lignes: [{
          type: "PRESTATION",
          designation: "SHERARDISATION 45µM",
          quantite: 12,
          prix_unitaire_ht: 4.5,
          remise_pct: 0,
          tva_pct: 20,
          frais_ht: 0,
          exigences_qualite: [],
          documents_attendus: [],
          besoins: [],
        }],
      },
      idempotency_key: "dd88a60a-b212-5b7b-a865-2579ef7cfcc1",
      parent_target_id: "5d9e2a31-6513-4b9c-a0df-df01a86e74cc",
      parent_target_code: "FOU-229",
      audit,
    });

    expect(createCommandeFournisseurSVC).toHaveBeenCalledWith(
      expect.objectContaining({
        fournisseur_id: "5d9e2a31-6513-4b9c-a0df-df01a86e74cc",
        idempotency_key: "dd88a60a-b212-5b7b-a865-2579ef7cfcc1",
        origine: "MANUEL",
        lignes: [expect.objectContaining({ type: "PRESTATION", quantite: 12 })],
      }),
      audit
    );
    expect(createCommandeFournisseurSVC.mock.calls[0][0]).not.toHaveProperty("fournisseur_legacy_code");
    expect(createCommandeFournisseurSVC.mock.calls[0][0]).not.toHaveProperty("date_commande_source");
    expect(result).toEqual({
      id: "3b9e2a31-6513-4b9c-a0df-df01a86e74cc",
      code: "BCF-2026-0042",
    });
  });
});
