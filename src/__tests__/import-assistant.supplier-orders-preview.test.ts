import { beforeEach, describe, expect, it, vi } from "vitest";

const repoMocks = vi.hoisted(() => ({
  repoGetBatch: vi.fn(),
  repoGetAllBatchRows: vi.fn(),
  repoFindCrosswalks: vi.fn(),
  repoFindStrongDuplicates: vi.fn(),
  repoSaveSimulation: vi.fn(),
}));

vi.mock("../module/import-assistant/repository/import-assistant.repository", () => repoMocks);
vi.mock("../module/audit-logs/repository/audit-logs.repository", () => ({
  repoInsertAuditLog: vi.fn(),
}));

import { previewImportBatch } from "../module/import-assistant/services/import-assistant.service";

const audit = {
  user_id: 1,
  ip: null,
  user_agent: null,
  device_type: null,
  os: null,
  browser: null,
  path: "/api/v1/import-assistant/batches/batch/preview",
  page_key: "import-assistant",
  client_session_id: null,
};

const batch = {
  id: "20925ec7-3adb-4403-afb7-97620fe09cc8",
  entity_type: "FOURNISSEUR_COMMANDE" as const,
  status: "UPLOADED" as const,
  source_system: "CLIPPER",
  source_name: "commandes-ouvertes.xlsx",
  source_sha256: "a".repeat(64),
  source_size: 1024,
  source_mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  sheet_name: "COMMANDES",
  headers: ["BC", "FOURNISSEUR", "DATE_COMMANDE", "DEVISE", "LIGNES_JSON"],
  mapping: null,
  preview_hash: null,
  summary: {
    total: 1,
    valid: 0,
    blocked: 0,
    duplicates: 0,
    already_imported: 0,
    imported: 0,
    linked: 0,
    failed: 0,
  },
  last_error: null,
  created_by: 1,
  created_at: "2026-07-27T00:00:00.000Z",
  updated_at: "2026-07-27T00:00:00.000Z",
  completed_at: null,
};

const sourceRow = {
  BC: "4542",
  FOURNISSEUR: "F272",
  DATE_COMMANDE: "2026-07-22",
  DEVISE: "EUR",
  LIGNES_JSON: JSON.stringify([{
    type: "PRESTATION",
    designation: "SHERARDISATION 45µM",
    quantite: 12,
    prix_unitaire_ht: 4.5,
  }]),
};

const mapping = {
  legacy_key_column: "BC",
  columns: {
    fournisseur_legacy_code: "FOURNISSEUR",
    date_commande_source: "DATE_COMMANDE",
    devise: "DEVISE",
    lignes_json: "LIGNES_JSON",
  },
  constants: {},
  approved_decisions: ["DEC-03", "DEC-14", "DEC-15", "DEC-17"],
  duplicate_strategy: "REVIEW" as const,
};

describe("Simulation des commandes fournisseurs CLIPPER", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    repoMocks.repoSaveSimulation.mockResolvedValue(undefined);
    repoMocks.repoFindStrongDuplicates.mockResolvedValue(new Map());
    repoMocks.repoGetBatch.mockResolvedValue(batch);
    repoMocks.repoGetAllBatchRows.mockResolvedValue([{ id: "1", source_data: sourceRow }]);
  });

  it("cible le fournisseur déjà rapproché", async () => {
    repoMocks.repoFindCrosswalks.mockImplementation(async (params: { entity_type: string }) =>
      params.entity_type === "FOURNISSEUR"
        ? new Map([["F272", { id: "5d9e2a31-6513-4b9c-a0df-df01a86e74cc", code: "FOU-229" }]])
        : new Map()
    );

    const result = await previewImportBatch({
      id: batch.id,
      mapping,
      audit,
    });

    expect(result.ready).toBe(true);
    expect(result.summary.valid).toBe(1);
    expect(repoMocks.repoSaveSimulation).toHaveBeenCalledWith(expect.objectContaining({
      rows: [expect.objectContaining({
        status: "VALID",
        target_id: "5d9e2a31-6513-4b9c-a0df-df01a86e74cc",
        target_code: "FOU-229",
      })],
    }));
  });

  it("bloque la commande tant que son fournisseur n'est pas rapproché", async () => {
    repoMocks.repoFindCrosswalks.mockResolvedValue(new Map());

    const result = await previewImportBatch({
      id: batch.id,
      mapping,
      audit,
    });

    expect(result.ready).toBe(false);
    expect(result.summary.blocked).toBe(1);
    expect(repoMocks.repoSaveSimulation).toHaveBeenCalledWith(expect.objectContaining({
      rows: [expect.objectContaining({
        status: "BLOCKED",
        action: "SKIP",
        issues: [expect.objectContaining({ code: "FOURNISSEUR_CROSSWALK_MISSING" })],
      })],
    }));
  });
});
