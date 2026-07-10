import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../module/temps-deplacements/repository/temps-deplacements-exports.repository", () => ({
  repoListWeeksForPeriod: vi.fn(),
  repoInsertExportBatch: vi.fn(),
  repoListExportBatches: vi.fn(),
  repoGetExportBatch: vi.fn(),
}));
vi.mock("../module/temps-deplacements/repository/temps-deplacements.repository", async (io) => {
  const actual = await io<typeof import("../module/temps-deplacements/repository/temps-deplacements.repository")>();
  return {
    ...actual,
    withTransaction: vi.fn(async (fn: (c: unknown) => unknown) => fn({ query: vi.fn() })),
    insertAuditLog: vi.fn(async () => undefined),
  };
});

import * as expRepo from "../module/temps-deplacements/repository/temps-deplacements-exports.repository";
import * as baseRepo from "../module/temps-deplacements/repository/temps-deplacements.repository";
import { buildPayrollCsv, sha256Hex, type PayrollWeekRow } from "../module/temps-deplacements/services/temps-deplacements-exports";
import * as svc from "../module/temps-deplacements/services/temps-deplacements-exports.service";

const repo = vi.mocked(expRepo);
const base = vi.mocked(baseRepo);
const AUDIT = { user_id: 9, ip: null, user_agent: null, device_type: null, os: null, browser: null, path: null, page_key: null, client_session_id: null };
const RH = { id: 9, role: "Responsable RH" };
const SALARIE = { id: 2, role: "Employee" };
const WEEK: PayrollWeekRow = {
  matricule: "TD001", name: "Jean", surname: "Dupont", week_start: "2026-03-02", week_end: "2026-03-08",
  worked_minutes: 2400, contract_minutes: 2100, overtime_25_minutes: 300, overtime_50_minutes: 0, absence_minutes: 0,
};

beforeEach(() => vi.clearAllMocks());

describe("T7 — createExport (figé + checksum, privilégié)", () => {
  it("CSV : octets gelés (base64) + checksum SHA-256 exact + audit", async () => {
    repo.repoListWeeksForPeriod.mockResolvedValue([WEEK]);
    repo.repoInsertExportBatch.mockImplementation(async (_c, i) => ({ id: "b1", ...i, status: "GENERATED", exported_at: "t" }));
    const r = await svc.createExport(RH, { period_start: "2026-03-01", period_end: "2026-03-31", format: "CSV" }, AUDIT);
    expect(r.row_count).toBe(1);

    const arg = repo.repoInsertExportBatch.mock.calls[0][1];
    const expectedCsv = buildPayrollCsv([WEEK]);
    const expectedChecksum = sha256Hex(Buffer.from(expectedCsv, "utf-8"));
    expect(arg.checksum).toBe(expectedChecksum);
    const frozen = arg.frozen_snapshot_json as { file_base64: string; row_count: number };
    expect(Buffer.from(frozen.file_base64, "base64").toString("utf-8")).toBe(expectedCsv); // gelé identique
    expect(base.insertAuditLog).toHaveBeenCalledWith(expect.anything(), AUDIT, expect.objectContaining({ action: "temps-deplacements.export.create" }));
  });
  it("période invalide (fin < début) → 400", async () => {
    await expect(svc.createExport(RH, { period_start: "2026-03-31", period_end: "2026-03-01", format: "CSV" }, AUDIT))
      .rejects.toMatchObject({ status: 400, code: "HR_EXPORT_BAD_PERIOD" });
  });
  it("un salarié ne peut PAS exporter → 403", async () => {
    await expect(svc.createExport(SALARIE, { period_start: "2026-03-01", period_end: "2026-03-31", format: "CSV" }, AUDIT))
      .rejects.toMatchObject({ status: 403, code: "HR_FORBIDDEN" });
    expect(repo.repoInsertExportBatch).not.toHaveBeenCalled();
  });
});

describe("T7 — getExportFile (intégrité vérifiée)", () => {
  const csv = buildPayrollCsv([WEEK]);
  const good = { file_base64: Buffer.from(csv, "utf-8").toString("base64"), filename: "paie.csv", content_type: "text/csv; charset=utf-8" };

  it("checksum correct → renvoie les octets figés", async () => {
    repo.repoGetExportBatch.mockResolvedValue({ id: "b1", checksum: sha256Hex(Buffer.from(csv, "utf-8")), frozen_snapshot_json: good });
    const f = await svc.getExportFile(RH, "11111111-1111-4111-8111-111111111111");
    expect(f.buffer.toString("utf-8")).toBe(csv);
  });
  it("checksum incohérent (altération) → 409", async () => {
    repo.repoGetExportBatch.mockResolvedValue({ id: "b1", checksum: "deadbeef", frozen_snapshot_json: good });
    await expect(svc.getExportFile(RH, "11111111-1111-4111-8111-111111111111")).rejects.toMatchObject({ status: 409, code: "HR_EXPORT_CHECKSUM_MISMATCH" });
  });
  it("introuvable → 404 ; salarié → 403", async () => {
    repo.repoGetExportBatch.mockResolvedValue(null);
    await expect(svc.getExportFile(RH, "11111111-1111-4111-8111-111111111111")).rejects.toMatchObject({ status: 404 });
    await expect(svc.getExportFile(SALARIE, "11111111-1111-4111-8111-111111111111")).rejects.toMatchObject({ status: 403 });
  });
});
