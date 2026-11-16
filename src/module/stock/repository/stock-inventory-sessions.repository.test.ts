import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  readQuery: vi.fn(),
  release: vi.fn(),
  connect: vi.fn(),
}));

vi.mock("../../../config/database", () => ({
  default: { query: mocks.readQuery, connect: mocks.connect },
}));

vi.mock("./stock-movement-core.repository", () => ({
  beginStockCommand: vi.fn(),
  completeStockCommand: vi.fn(),
  insertAuditLog: vi.fn(),
  insertMovementEvent: vi.fn(),
  lockStockStates: vi.fn(),
  stockTargetKey: vi.fn(),
  assertStockConsumptionAllowed: vi.fn(),
  reserveMovementNo: vi.fn(),
}));

import { beginStockCommand, completeStockCommand, insertAuditLog } from "./stock-movement-core.repository";
import { repoCloseInventorySession, repoStartInventorySession } from "./stock-inventory-sessions.repository";

describe("stock inventory session owner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.query.mockReset();
    mocks.readQuery.mockReset();
    mocks.connect.mockResolvedValue({ query: mocks.query, release: mocks.release });
    (beginStockCommand as ReturnType<typeof vi.fn>).mockResolvedValue({
      correlation_id: "00000000-0000-0000-0000-000000000001",
      existing: null,
    });
  });

  function returnSessionDetail(id: string, status: string) {
    const session = { id, status, session_no: "INV-00000001", row_version: 5 };
    mocks.readQuery
      .mockResolvedValueOnce({ rows: [session] })
      .mockResolvedValueOnce({ rows: [{ ok: 1 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    return { session, lines: [], adjustment_movement_ids: [] };
  }

  it("starts a snapshot and records its audit and command receipt before committing", async () => {
    const id = "00000000-0000-0000-0000-000000000002";
    const detail = returnSessionDetail(id, "OPEN");
    mocks.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ status: "DRAFT", session_no: "INV-00000001", row_version: 4 }] })
      .mockResolvedValueOnce({ rows: [{ id: "snapshot-line" }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(repoStartInventorySession(id, { expected_version: 4 }, { user_id: 7 } as never, "start-ok"))
      .resolves.toEqual(detail);

    expect(mocks.query.mock.calls[1]?.[0]).toContain("FOR UPDATE");
    expect(mocks.query.mock.calls[2]?.[0]).toContain("INSERT INTO public.stock_inventory_snapshot_lines");
    expect(mocks.query.mock.calls[3]?.[0]).toContain("status = 'OPEN'");
    expect(insertAuditLog).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({
      action: "stock.inventory_sessions.start",
      details: expect.objectContaining({ snapshot_lines_count: 1 }),
    }));
    expect(completeStockCommand).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      command_type: "INVENTORY_START", resource_id: id,
    }));
    const commitIndex = mocks.query.mock.calls.findIndex(([sql]) => sql === "COMMIT");
    expect(commitIndex).toBe(4);
    expect(vi.mocked(insertAuditLog).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(completeStockCommand).mock.invocationCallOrder[0]!);
    expect(vi.mocked(completeStockCommand).mock.invocationCallOrder[0]).toBeLessThan(mocks.query.mock.invocationCallOrder[commitIndex]!);
    expect(mocks.query.mock.calls.map(([sql]) => sql)).not.toContain("ROLLBACK");
    expect(mocks.release).toHaveBeenCalledExactlyOnceWith();
  });

  it("replays a completed close without creating another adjustment, audit or command receipt", async () => {
    const id = "00000000-0000-0000-0000-000000000002";
    const priorId = "00000000-0000-0000-0000-000000000003";
    const detail = returnSessionDetail(priorId, "CLOSED");
    vi.mocked(beginStockCommand).mockResolvedValueOnce({
      correlation_id: "00000000-0000-0000-0000-000000000001",
      existing: { resource_id: priorId },
    } as never);
    mocks.query.mockResolvedValue({ rows: [] });

    await expect(repoCloseInventorySession(id, { expected_version: 7 }, { user_id: 7 } as never, "close-replay"))
      .resolves.toEqual(detail);

    expect(mocks.query.mock.calls.map(([sql]) => sql)).toEqual(["BEGIN", "COMMIT"]);
    expect(insertAuditLog).not.toHaveBeenCalled();
    expect(completeStockCommand).not.toHaveBeenCalled();
    expect(mocks.readQuery.mock.calls[0]?.[1]).toEqual([priorId]);
    expect(mocks.release).toHaveBeenCalledExactlyOnceWith();
  });

  it("locks the session, rejects a stale version, and rolls the transaction back before release", async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({
        rows: [{ status: "DRAFT", session_no: "INV-00000001", row_version: 4 }],
      }); // SELECT ... FOR UPDATE

    await expect(
      repoStartInventorySession(
        "00000000-0000-0000-0000-000000000002",
        { expected_version: 3 },
        { user_id: "tester" } as never,
        "inventory-start-stale"
      )
    ).rejects.toMatchObject({ code: "CONCURRENT_MODIFICATION" });

    expect(mocks.query.mock.calls.map(([sql]) => sql)).toContain("ROLLBACK");
    expect(mocks.release).toHaveBeenCalledTimes(1);
    expect(mocks.query.mock.calls[1]?.[0]).toContain("FOR UPDATE");
  });

  it("keeps close in its transaction when the locked version is stale", async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({
        rows: [{ status: "APPROVED", session_no: "INV-00000001", row_version: 8 }],
      }); // SELECT ... FOR UPDATE

    await expect(
      repoCloseInventorySession(
        "00000000-0000-0000-0000-000000000002",
        { expected_version: 7 },
        { user_id: "tester" } as never,
        "inventory-close-stale"
      )
    ).rejects.toMatchObject({ code: "CONCURRENT_MODIFICATION" });

    expect(mocks.query.mock.calls.map(([sql]) => sql)).toEqual(expect.arrayContaining(["BEGIN", "ROLLBACK"]));
    expect(mocks.query.mock.calls[1]?.[0]).toContain("FOR UPDATE");
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });
});
