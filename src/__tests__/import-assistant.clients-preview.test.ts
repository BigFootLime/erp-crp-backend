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

function batch(entityType: "CLIENT_ENRICHISSEMENT" | "CLIENT_CONTACT") {
  return {
    id: "20925ec7-3adb-4403-afb7-97620fe09cc8",
    entity_type: entityType,
    status: "UPLOADED",
    source_system: "CLIPPER",
    source_name: "pilote.xlsx",
    source_sha256: "a".repeat(64),
    source_size: 1024,
    source_mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    sheet_name: "Import",
    headers: entityType === "CLIENT_ENRICHISSEMENT"
      ? ["CODE", "NOM", "EMAIL"]
      : ["CONTACT_KEY", "CLIENT_CODE", "PRENOM", "NOM", "EMAIL"],
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
}

describe("Simulation clients spécialisés", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    repoMocks.repoSaveSimulation.mockResolvedValue(undefined);
    repoMocks.repoFindStrongDuplicates.mockResolvedValue(new Map());
  });

  it("cible le client déjà rapproché pour un enrichissement parcimonieux", async () => {
    repoMocks.repoGetBatch.mockResolvedValue(batch("CLIENT_ENRICHISSEMENT"));
    repoMocks.repoGetAllBatchRows.mockResolvedValue([{
      id: "1",
      source_data: { CODE: "C001", NOM: "Client un", EMAIL: "client@example.fr" },
    }]);
    repoMocks.repoFindCrosswalks.mockImplementation(async (params: { entity_type: string }) =>
      params.entity_type === "CLIENT"
        ? new Map([["C001", { id: "5d9e2a31-6513-4b9c-a0df-df01a86e74cc", code: "CLI-0001" }]])
        : new Map()
    );

    const result = await previewImportBatch({
      id: "20925ec7-3adb-4403-afb7-97620fe09cc8",
      mapping: {
        legacy_key_column: "CODE",
        columns: { company_name: "NOM", email: "EMAIL" },
        constants: {},
        approved_decisions: ["DEC-04", "DEC-14", "DEC-15"],
        duplicate_strategy: "LINK_EXACT",
      },
      audit,
    });

    expect(result.ready).toBe(true);
    expect(result.summary.valid).toBe(1);
    expect(repoMocks.repoSaveSimulation).toHaveBeenCalledWith(expect.objectContaining({
      rows: [expect.objectContaining({
        status: "VALID",
        target_id: "5d9e2a31-6513-4b9c-a0df-df01a86e74cc",
        target_code: "CLI-0001",
      })],
    }));
  });

  it("bloque un contact tant que son client parent n'est pas rapproché", async () => {
    repoMocks.repoGetBatch.mockResolvedValue(batch("CLIENT_CONTACT"));
    repoMocks.repoGetAllBatchRows.mockResolvedValue([{
      id: "2",
      source_data: {
        CONTACT_KEY: "C404|1",
        CLIENT_CODE: "C404",
        PRENOM: "Alice",
        NOM: "Martin",
        EMAIL: "alice@example.fr",
      },
    }]);
    repoMocks.repoFindCrosswalks.mockResolvedValue(new Map());

    const result = await previewImportBatch({
      id: "20925ec7-3adb-4403-afb7-97620fe09cc8",
      mapping: {
        legacy_key_column: "CONTACT_KEY",
        columns: {
          client_legacy_code: "CLIENT_CODE",
          first_name: "PRENOM",
          last_name: "NOM",
          email: "EMAIL",
        },
        constants: {},
        approved_decisions: ["DEC-04", "DEC-14", "DEC-15"],
        duplicate_strategy: "REVIEW",
      },
      audit,
    });

    expect(result.ready).toBe(false);
    expect(result.summary.blocked).toBe(1);
    expect(repoMocks.repoSaveSimulation).toHaveBeenCalledWith(expect.objectContaining({
      rows: [expect.objectContaining({
        status: "BLOCKED",
        action: "SKIP",
        issues: [expect.objectContaining({ code: "CLIENT_CROSSWALK_MISSING" })],
      })],
    }));
  });
});
