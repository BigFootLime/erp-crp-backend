import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
}));

vi.mock("../../../config/database", () => ({
  default: {
    connect: mocks.connect,
    query: vi.fn(),
  },
}));

import { repoAcquireLock, repoExpireLocks, repoReleaseLock } from "./locks.repository";
import { withRealtimeOutboxDbMock } from "../../../__tests__/helpers/realtime-outbox-db-mock";

const LOCK_ID = "11111111-1111-4111-8111-111111111111";
const EXPIRES_AT = "2026-08-04T14:30:00.000Z";

function makeClient(options: {
  operation?: "acquire" | "release" | "expire";
  entityExists?: boolean;
  failOutbox?: boolean;
  failCommit?: boolean;
} = {}) {
  const release = vi.fn();
  const query = vi.fn(withRealtimeOutboxDbMock(async (sql: unknown) => {
    const statement = String(sql);
    if (statement.includes("SELECT EXISTS")) {
      return { rows: [{ entity_exists: options.entityExists !== false }], rowCount: 1 };
    }
    if (statement.includes("WITH upsert AS")) {
      return {
        rows: [{
          id: LOCK_ID,
          entity_type: "COMMANDE_CLIENT",
          entity_id: "123",
          locked_at: "2026-08-04T14:20:00.000Z",
          expires_at: EXPIRES_AT,
          locked_by_id: 7,
          locked_by_name: "keenan",
        }],
        rowCount: 1,
      };
    }
    if (options.operation === "release" && statement.includes("RETURNING id::text AS id")) {
      return { rows: [{ id: LOCK_ID }], rowCount: 1 };
    }
    if (options.operation === "expire" && statement.includes("WITH expired AS")) {
      return {
        rows: [{
          id: LOCK_ID,
          entity_type: "COMMANDE_CLIENT",
          entity_id: "123",
          expires_at: EXPIRES_AT,
        }],
        rowCount: 1,
      };
    }
    if (statement === "COMMIT" && options.failCommit) throw new Error("COMMIT_ACK_LOST");
    return { rows: [], rowCount: 0 };
  }, {
    onOutboxInsert: (_sql, params) => {
      if (options.failOutbox) throw new Error("OUTBOX_UNAVAILABLE");
      return { rows: [{ event_id: String(params?.[5]) }], rowCount: 1 };
    },
  }));
  return { query, release };
}

function outboxKeys(client: ReturnType<typeof makeClient>): string[] {
  return client.query.mock.calls
    .filter(([sql]) => String(sql).includes("INSERT INTO public.erp_outbox_events"))
    .map(([, params]) => String(params?.[0]));
}

describe("locks realtime transaction outbox", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("enqueues an acquired lock before COMMIT with a stable key", async () => {
    const firstClient = makeClient();
    const secondClient = makeClient();
    mocks.connect.mockResolvedValueOnce(firstClient).mockResolvedValueOnce(secondClient);

    await repoAcquireLock({ entity_type: "COMMANDE_CLIENT", entity_id: "123", user_id: 7 });
    await repoAcquireLock({ entity_type: "COMMANDE_CLIENT", entity_id: "123", user_id: 7 });

    const expected = [`realtime:lock:${LOCK_ID}:held:${EXPIRES_AT}`];
    expect(outboxKeys(firstClient)).toEqual(expected);
    expect(outboxKeys(secondClient)).toEqual(expected);
    const commitIndex = firstClient.query.mock.calls.findIndex(([sql]) => String(sql) === "COMMIT");
    const outboxIndex = firstClient.query.mock.calls.findIndex(([sql]) =>
      String(sql).includes("INSERT INTO public.erp_outbox_events")
    );
    expect(commitIndex).toBeGreaterThan(outboxIndex);
  });

  it("rolls back a release when its outbox enqueue fails", async () => {
    const client = makeClient({ operation: "release", failOutbox: true });
    mocks.connect.mockResolvedValueOnce(client);

    await expect(repoReleaseLock({
      entity_type: "COMMANDE_CLIENT",
      entity_id: "123",
      user_id: 7,
    })).rejects.toThrow("OUTBOX_UNAVAILABLE");

    const statements = client.query.mock.calls.map(([sql]) => String(sql));
    expect(statements).toContain("ROLLBACK");
    expect(statements).not.toContain("COMMIT");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("does not create a lock or outbox row when the canonical entity does not exist", async () => {
    const client = makeClient({ entityExists: false });
    mocks.connect.mockResolvedValueOnce(client);

    await expect(repoAcquireLock({
      entity_type: "COMMANDE_CLIENT",
      entity_id: "123",
      user_id: 7,
    })).resolves.toEqual({ entityExists: false, acquired: false, lock: null });

    const statements = client.query.mock.calls.map(([sql]) => String(sql));
    expect(statements.some((sql) => sql.includes("WITH upsert AS"))).toBe(false);
    expect(statements.some((sql) => sql.includes("INSERT INTO public.erp_outbox_events"))).toBe(false);
  });

  it("resolves a lost COMMIT acknowledgement without issuing ROLLBACK", async () => {
    const client = makeClient({ failCommit: true });
    const eventKey = `realtime:lock:${LOCK_ID}:held:${EXPIRES_AT}`;
    const verifier = {
      query: vi.fn().mockResolvedValue({ rows: [{ event_key: eventKey }] }),
      release: vi.fn(),
    };
    mocks.connect.mockResolvedValueOnce(client).mockResolvedValueOnce(verifier);

    const result = await repoAcquireLock({
      entity_type: "COMMANDE_CLIENT",
      entity_id: "123",
      user_id: 7,
    });

    expect(result.acquired).toBe(true);
    expect(client.query.mock.calls.map(([sql]) => String(sql))).not.toContain("ROLLBACK");
    expect(client.release).toHaveBeenCalledWith(true);
    expect(verifier.release).toHaveBeenCalledOnce();
  });

  it("deletes an expired lock and enqueues its unlock before the same COMMIT", async () => {
    const client = makeClient({ operation: "expire" });
    mocks.connect.mockResolvedValueOnce(client);

    await expect(repoExpireLocks()).resolves.toBe(1);

    const statements = client.query.mock.calls.map(([sql]) => String(sql));
    const deleteIndex = statements.findIndex((sql) => sql.includes("DELETE FROM public.entity_locks lock"));
    const outboxIndex = statements.findIndex((sql) => sql.includes("INSERT INTO public.erp_outbox_events"));
    const commitIndex = statements.indexOf("COMMIT");
    expect(deleteIndex).toBeGreaterThan(-1);
    expect(outboxIndex).toBeGreaterThan(deleteIndex);
    expect(commitIndex).toBeGreaterThan(outboxIndex);
    expect(outboxKeys(client)).toEqual([`realtime:lock:${LOCK_ID}:expired:${EXPIRES_AT}`]);
  });
});
