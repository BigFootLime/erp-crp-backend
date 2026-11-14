import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  release: vi.fn(),
  connect: vi.fn(),
}));

vi.mock("../../../config/database", () => ({
  default: { query: mocks.query, connect: mocks.connect },
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

import { beginStockCommand } from "./stock-movement-core.repository";
import { repoCloseInventorySession, repoStartInventorySession } from "./stock-inventory-sessions.repository";

describe("stock inventory session owner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.connect.mockResolvedValue({ query: mocks.query, release: mocks.release });
    (beginStockCommand as ReturnType<typeof vi.fn>).mockResolvedValue({
      correlation_id: "00000000-0000-0000-0000-000000000001",
      existing: null,
    });
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
