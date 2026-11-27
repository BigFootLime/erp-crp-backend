import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn(), release: vi.fn(), audit: vi.fn() }));
vi.mock("../config/database", () => ({ default: { connect: async () => ({ query: mocks.query, release: mocks.release }) } }));
vi.mock("../module/audit-logs/repository/audit-logs.repository", () => ({ repoInsertAuditLog: mocks.audit }));

import { repoDecideReferenceChangeSet } from "../module/reference-data/repository/reference-data.repository";
import type { ReferenceDataAuditContext } from "../module/reference-data/types/reference-data.types";

const id = "11111111-1111-4111-8111-111111111111";
const audit: ReferenceDataAuditContext = {
  user_id: 1, role: "Administrateur", ip: null, user_agent: "vitest", device_type: null,
  os: null, browser: null, path: "/api/v1/admin/reference-data", page_key: "reference-data", client_session_id: null,
};
let databaseName: string | undefined;
let row: Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  databaseName = "cerp_test";
  row = { id, status: "PENDING_APPROVAL", proposed_by: 1, changes: [], comparison: [], affected_modules: ["Stock"] };
  mocks.query.mockImplementation(async (sql: string, values?: unknown[]) => {
    if (sql.includes("AS installed")) return { rows: [{ installed: true }] };
    if (sql.includes("current_database()")) return { rows: databaseName ? [{ database_name: databaseName }] : [] };
    if (sql.includes("SELECT request_sha256")) return { rows: [] };
    if (sql.includes("UPDATE public.reference_data_change_sets")) {
      row = { ...row, status: sql.includes("status='APPROVED'") ? "APPROVED" : "REJECTED", approved_by: values?.[1] };
      return { rows: [] };
    }
    if (sql.includes("FROM public.reference_data_change_sets")) return { rows: [{ ...row }] };
    return { rows: [] };
  });
});

describe("Reference decisions use the actual transaction database", () => {
  it("lets the proposer approve on the shared test database and records the exception", async () => {
    const result = await repoDecideReferenceChangeSet(id, { idempotency_key: "self-test-1", decision: "APPROVE", reason: "Paramétrage de la base test" }, audit);
    expect(result.change_set).toMatchObject({ status: "APPROVED", approved_by: 1, proposed_by: 1 });
    expect(mocks.query).toHaveBeenCalledWith("SELECT current_database()::text AS database_name");
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ user_id: 1, body: expect.objectContaining({
      details: expect.objectContaining({ self_decision: true, database_name: "cerp_test", actor_separation_policy: "TEST_SELF_APPROVAL" }),
    }) }));
    expect(mocks.query).toHaveBeenCalledWith("COMMIT");
  });

  it.each(["cerp_prod", "cerp_e2e", "cerp_test_copy", undefined])("refuses self-approval outside the exact test database (%s)", async name => {
    databaseName = name;
    await expect(repoDecideReferenceChangeSet(id, { idempotency_key: "self-prod-1", decision: "APPROVE", reason: "Self approval attempt" }, audit))
      .rejects.toMatchObject({ status: 403, code: "FOUR_EYES_APPROVAL_REQUIRED" });
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes("UPDATE public.reference_data_change_sets"))).toBe(false);
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(mocks.query).toHaveBeenCalledWith("ROLLBACK");
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it("keeps distinct-user production approval available", async () => {
    databaseName = "cerp_prod";
    row.proposed_by = 2;
    const result = await repoDecideReferenceChangeSet(id, { idempotency_key: "other-prod-1", decision: "APPROVE", reason: "Source contrôlée par une autre personne" }, audit);
    expect(result.change_set).toMatchObject({ status: "APPROVED", approved_by: 1, proposed_by: 2 });
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes("current_database()"))).toBe(false);
  });
});
