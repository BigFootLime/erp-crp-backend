import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  query: vi.fn(), transactionQuery: vi.fn(), audit: vi.fn(), event: vi.fn(),
}));
vi.mock("../module/metrologie/repository/metrology-shared.repository", () => ({
  db: () => ({ query: mock.query }),
  withTransaction: async (fn: (client: { query: typeof mock.transactionQuery }) => unknown) => fn({ query: mock.transactionQuery }),
  insertAuditLog: (...args: unknown[]) => mock.audit(...args),
  insertMetrologyEvent: (...args: unknown[]) => mock.event(...args),
}));
import { repoApplyStagedLegacyBatch, repoListLegacyImportRows, repoResolveLegacyImportRow } from "../module/metrologie/repository/metrology-legacy-import.repository";

const actor = { user_id: 7, role: "metrolog", ip: null, user_agent: null, device_type: null, os: null, browser: null, path: "test", page_key: null, client_session_id: null, request_id: null };
const batch = "11111111-1111-4111-8111-111111111111";
const row = "22222222-2222-4222-8222-222222222222";
const equipment = "33333333-3333-4333-8333-333333333333";

beforeEach(() => { for (const fn of Object.values(mock)) fn.mockReset(); });

describe("legacy metrology import repository", () => {
  it("uses record_kind filters and counts an empty later page with the same filters", async () => {
    mock.query.mockResolvedValueOnce({ rows: [], rowCount: 0 }).mockResolvedValueOnce({ rows: [{ total: "151" }], rowCount: 1 });
    await expect(repoListLegacyImportRows(batch, 3, 50, { kind: "history", disposition: "AMBIGUOUS" })).resolves.toEqual({ items: [], total: 151 });
    const [sql, values] = mock.query.mock.calls[0];
    expect(sql).toContain("normalized->>'record_kind'");
    expect(values).toEqual([batch, "AMBIGUOUS", "history", 50, 100]);
    expect(mock.query.mock.calls[1][1]).toEqual([batch, "AMBIGUOUS", "history"]);
  });

  it("rejects a row that is not in the selected parent batch", async () => {
    mock.transactionQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await expect(repoResolveLegacyImportRow({ batchId: batch, rowId: row, equipmentId: equipment, disposition: "IMPORTED", reason: "test", actor })).rejects.toMatchObject({ status: 404 });
    expect(mock.transactionQuery.mock.calls[0][0]).toContain("f.batch_id=$2::uuid");
  });

  it("refuses a manual source-evidence row before it can create an observation", async () => {
    mock.transactionQuery.mockResolvedValueOnce({ rows: [{ normalized: { record_kind: "source-row" }, raw_cells: {}, target_equipment_id: null }], rowCount: 1 });
    await expect(repoResolveLegacyImportRow({ batchId: batch, rowId: row, equipmentId: equipment, disposition: "IMPORTED", reason: "test", actor })).rejects.toMatchObject({ code: "METROLOGY_IMPORT_RESOLUTION_KIND" });
    expect(mock.transactionQuery).toHaveBeenCalledTimes(1);
  });

  it("allows an attachment association without fabricating a legacy observation", async () => {
    mock.transactionQuery
      .mockResolvedValueOnce({ rows: [{ normalized: { record_kind: "attachment" }, raw_cells: {}, target_equipment_id: null }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ ok: 1 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: row, disposition: "IMPORTED", target_equipment_id: equipment }], rowCount: 1 });
    mock.audit.mockResolvedValue(undefined);
    await expect(repoResolveLegacyImportRow({ batchId: batch, rowId: row, equipmentId: equipment, disposition: "IMPORTED", reason: "association justificative", actor })).resolves.toMatchObject({ disposition: "IMPORTED" });
    expect(mock.transactionQuery.mock.calls.some(([sql]) => String(sql).includes("metrologie_legacy_observations"))).toBe(false);
  });

  it("does not permit an existing immutable observation to move to another instrument", async () => {
    mock.transactionQuery
      .mockResolvedValueOnce({ rows: [{ normalized: { record_kind: "history" }, raw_cells: {}, target_equipment_id: null }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ ok: 1 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ equipement_id: "44444444-4444-4444-8444-444444444444" }], rowCount: 1 });
    await expect(repoResolveLegacyImportRow({ batchId: batch, rowId: row, equipmentId: equipment, disposition: "IMPORTED", reason: "test", actor })).rejects.toMatchObject({ code: "METROLOGY_IMPORT_OBSERVATION_IMMUTABLE" });
  });

  it("imports a valid staged equipment with its fiche and batch provenance", async () => {
    const equipmentRow = { id: row, sha256: "a".repeat(64), normalized: { record_kind: "equipment", group_id: "PC-01", group_kind: "registry-apparatus", observed_code_verbatim: "PC-01", registry_evidence: { COCONTR: "PC-01", DESA1: "Pied", MARQU: "Marque", NUMSERIE: "0007" }, fiche_metrologie: { profile_code: "PC", historique: { PERIOD: "12" }, control_schema: { version: 1, fields: [] } } } };
    mock.transactionQuery
      .mockResolvedValueOnce({ rows: [{ source_set_sha256: "b".repeat(64), status: "STAGED" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ clean: 1, total: 1 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [equipmentRow], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ id: equipment }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    mock.event.mockResolvedValue(undefined); mock.audit.mockResolvedValue(undefined);
    const result = await repoApplyStagedLegacyBatch({ batchId: batch, actor });
    expect(result).toMatchObject({ replay: false, equipment_created: 1, history_imported: 0 });
    const insert = mock.transactionQuery.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO public.metrologie_equipements"));
    expect(JSON.parse(insert[1][8])).toMatchObject({ legacy_import: { batch_id: batch, group_id: "PC-01" }, fiche_metrologie: { version: 1, profile_code: "PC", historique: { PERIOD: "12" } } });
    expect(insert[1][3]).toBe("0007");
  });

  it("returns a replay result without recreating equipment after a batch is applied", async () => {
    mock.transactionQuery.mockResolvedValueOnce({ rows: [{ source_set_sha256: "c".repeat(64), status: "APPLIED" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ equipment_created: 364, history_imported: 1035 }], rowCount: 1 });
    await expect(repoApplyStagedLegacyBatch({ batchId: batch, actor })).resolves.toEqual({ batch_id: batch, replay: true, equipment_created: 364, history_imported: 1035 });
    expect(mock.transactionQuery).toHaveBeenCalledTimes(2);
  });
});
