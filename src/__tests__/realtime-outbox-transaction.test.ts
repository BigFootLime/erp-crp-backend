import type { PoolClient } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ connect: vi.fn() }));

vi.mock("../config/database", () => ({
  default: { connect: mocks.connect },
}));

import {
  RealtimeCommitUncertainError,
  trackInsertedRealtimeOutboxEvent,
  withRealtimeOutboxTransaction,
} from "../shared/realtime/realtime-outbox-transaction";

function client(query: (sql: string, params?: unknown[]) => Promise<unknown>) {
  return {
    query: vi.fn(query),
    release: vi.fn(),
  } as unknown as PoolClient & { query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> };
}

describe("realtime outbox transaction outcome", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns success after an ACK-lost COMMIT when every expected event key is visible", async () => {
    const primary = client(async (sql) => {
      if (sql === "COMMIT") throw new Error("commit ack lost");
      return { rows: [] };
    });
    const verifier = client(async () => ({ rows: [{ event_key: "realtime:mutation:1" }] }));
    mocks.connect.mockResolvedValueOnce(verifier);

    await expect(withRealtimeOutboxTransaction(primary, async (tx) => {
      trackInsertedRealtimeOutboxEvent(tx, {
        eventKey: "realtime:mutation:1",
        eventId: "00000000-0000-4000-8000-000000000001",
      });
      return { id: 1 };
    })).resolves.toEqual({ id: 1 });

    expect(primary.release).toHaveBeenCalledWith(true);
    expect(primary.query).not.toHaveBeenCalledWith("ROLLBACK");
    expect(verifier.release).toHaveBeenCalledWith();
  });

  it("preserves a confirmed failed COMMIT when no expected key is visible", async () => {
    const commitError = new Error("commit failed");
    const primary = client(async (sql) => {
      if (sql === "COMMIT") throw commitError;
      return { rows: [] };
    });
    mocks.connect.mockResolvedValueOnce(client(async () => ({ rows: [] })));

    await expect(withRealtimeOutboxTransaction(primary, async (tx) => {
      trackInsertedRealtimeOutboxEvent(tx, {
        eventKey: "realtime:mutation:2",
        eventId: "00000000-0000-4000-8000-000000000002",
      });
      return 2;
    })).rejects.toBe(commitError);
    expect(primary.query).not.toHaveBeenCalledWith("ROLLBACK");
  });

  it("accepts domain evidence after a lost COMMIT when a mutation has no outbox key", async () => {
    const primary = client(async (sql) => {
      if (sql === "COMMIT") throw new Error("commit ack lost");
      return { rows: [] };
    });
    const verifier = client(async () => ({ rows: [{ revision: "12" }] }));
    mocks.connect.mockResolvedValueOnce(verifier);

    await expect(withRealtimeOutboxTransaction(primary, async () => ({ revision: 12 }), {
      reconcileCommit: async (connection, result) => {
        const { rows } = await connection.query("SELECT revision");
        return Number((rows as Array<{ revision: string }>)[0]?.revision) >= result.revision
          ? "committed"
          : "not_committed";
      },
    })).resolves.toEqual({ revision: 12 });

    expect(primary.release).toHaveBeenCalledWith(true);
    expect(primary.query).not.toHaveBeenCalledWith("ROLLBACK");
    expect(verifier.release).toHaveBeenCalledWith();
  });

  it("preserves the COMMIT error when domain evidence proves no-key work was not committed", async () => {
    const commitError = new Error("commit rejected");
    const primary = client(async (sql) => {
      if (sql === "COMMIT") throw commitError;
      return { rows: [] };
    });
    mocks.connect.mockResolvedValueOnce(client(async () => ({ rows: [{ revision: "11" }] })));

    await expect(withRealtimeOutboxTransaction(primary, async () => ({ revision: 12 }), {
      reconcileCommit: async (connection, result) => {
        const { rows } = await connection.query("SELECT revision");
        return Number((rows as Array<{ revision: string }>)[0]?.revision) >= result.revision
          ? "committed"
          : "not_committed";
      },
    })).rejects.toBe(commitError);
  });

  it("returns a typed 503 and destroys both connections when reconciliation is unavailable", async () => {
    const primary = client(async (sql) => {
      if (sql === "COMMIT") throw new Error("commit ack lost");
      return { rows: [] };
    });
    const verifier = client(async () => { throw new Error("verification outage"); });
    mocks.connect.mockResolvedValueOnce(verifier);

    const promise = withRealtimeOutboxTransaction(primary, async (tx) => {
      trackInsertedRealtimeOutboxEvent(tx, {
        eventKey: "realtime:mutation:3",
        eventId: "00000000-0000-4000-8000-000000000003",
      });
      return 3;
    });
    await expect(promise).rejects.toBeInstanceOf(RealtimeCommitUncertainError);
    await expect(promise).rejects.toMatchObject({ status: 503, code: "REALTIME_COMMIT_OUTCOME_UNKNOWN" });
    expect(primary.release).toHaveBeenCalledWith(true);
    expect(verifier.release).toHaveBeenCalledWith(true);
  });

  it("destroys a connection and returns a safe 503 when BEGIN fails", async () => {
    const primary = client(async (sql) => {
      if (sql === "BEGIN") throw new Error("begin outage");
      return { rows: [] };
    });
    await expect(withRealtimeOutboxTransaction(primary, async () => 1)).rejects.toMatchObject({
      status: 503,
      code: "REALTIME_TRANSACTION_START_FAILED",
    });
    expect(primary.release).toHaveBeenCalledWith(true);
    expect(primary.query).not.toHaveBeenCalledWith("ROLLBACK");
  });

  it("returns the work error after a confirmed rollback", async () => {
    const workError = new Error("business failure");
    const primary = client(async () => ({ rows: [] }));
    await expect(withRealtimeOutboxTransaction(primary, async () => { throw workError; })).rejects.toBe(workError);
    expect(primary.query).toHaveBeenCalledWith("ROLLBACK");
    expect(primary.release).toHaveBeenCalledWith();
  });

  it("returns a typed 503 and destroys the connection when ROLLBACK is uncertain", async () => {
    const primary = client(async (sql) => {
      if (sql === "ROLLBACK") throw new Error("rollback ack lost");
      return { rows: [] };
    });
    await expect(withRealtimeOutboxTransaction(primary, async () => {
      throw new Error("business failure");
    })).rejects.toBeInstanceOf(RealtimeCommitUncertainError);
    expect(primary.release).toHaveBeenCalledWith(true);
  });

  it("fails before inner SQL when the same client is nested without an explicit join", async () => {
    const primary = client(async () => ({ rows: [] }));
    const innerWork = vi.fn(async () => "inner");

    await expect(withRealtimeOutboxTransaction(primary, async (tx) => {
      return withRealtimeOutboxTransaction(tx, innerWork);
    })).rejects.toMatchObject({
      status: 500,
      code: "REALTIME_NESTED_TRANSACTION_FORBIDDEN",
    });

    expect(innerWork).not.toHaveBeenCalled();
    expect(primary.query.mock.calls.map(([sql]) => String(sql))).toEqual(["BEGIN", "ROLLBACK"]);
    expect(primary.release).toHaveBeenCalledTimes(1);
  });

  it("lets an explicit nested join share commit evidence while only the outer owner commits and releases", async () => {
    const outerKey = "realtime:mutation:outer";
    const innerKey = "realtime:mutation:inner";
    const primary = client(async (sql) => {
      if (sql === "COMMIT") throw new Error("commit ack lost");
      return { rows: [] };
    });
    const verifier = client(async (_sql, params) => {
      expect(params?.[0]).toEqual([outerKey, innerKey]);
      return { rows: [{ event_key: outerKey }, { event_key: innerKey }] };
    });
    mocks.connect.mockResolvedValueOnce(verifier);

    await expect(withRealtimeOutboxTransaction(primary, async (tx) => {
      trackInsertedRealtimeOutboxEvent(tx, {
        eventKey: outerKey,
        eventId: "00000000-0000-4000-8000-000000000011",
      });
      await withRealtimeOutboxTransaction(tx, async (joined) => {
        trackInsertedRealtimeOutboxEvent(joined, {
          eventKey: innerKey,
          eventId: "00000000-0000-4000-8000-000000000012",
        });
      }, { joinExistingTransaction: true });
      return "committed";
    })).resolves.toBe("committed");

    const statements = primary.query.mock.calls.map(([sql]) => String(sql));
    expect(statements.filter((sql) => sql === "BEGIN")).toHaveLength(1);
    expect(statements.filter((sql) => sql === "COMMIT")).toHaveLength(1);
    expect(statements).not.toContain("ROLLBACK");
    expect(primary.release).toHaveBeenCalledTimes(1);
    expect(primary.release).toHaveBeenCalledWith(true);
  });
});
