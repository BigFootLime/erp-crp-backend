import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  clientQuery: vi.fn(),
  clientRelease: vi.fn(),
  connect: vi.fn(),
  poolQuery: vi.fn(),
}));

vi.mock("../config/database", () => ({
  default: {
    connect: mocks.connect,
    query: mocks.poolQuery,
  },
}));

import {
  MemoryChatPresenceRegistry,
  PostgresChatPresenceRegistry,
} from "../shared/realtime/chat-presence.registry";

describe("chat presence registry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.connect.mockResolvedValue({ query: mocks.clientQuery, release: mocks.clientRelease });
  });

  it("emits only the first-online and last-offline transitions for multiple sockets", async () => {
    const registry = new MemoryChatPresenceRegistry();
    await expect(registry.connect(7, "socket-a")).resolves.toEqual({ userId: 7, online: true });
    await expect(registry.connect(7, "socket-b")).resolves.toBeNull();
    await expect(registry.snapshot()).resolves.toEqual({ known: true, onlineUserIds: [7] });
    await expect(registry.disconnect(7, "socket-a")).resolves.toBeNull();
    await expect(registry.disconnect(7, "socket-b")).resolves.toEqual({ userId: 7, online: false });
  });

  it("takes the per-user advisory lock before deleting expired rows during a sweep", async () => {
    mocks.clientQuery.mockImplementation(async (statement: unknown) => {
      const sql = String(statement);
      if (sql.includes("SELECT DISTINCT user_id::text")) return { rows: [{ user_id: "7" }] };
      if (sql.includes("DELETE FROM public.realtime_chat_presence")) return { rows: [], rowCount: 1 };
      if (sql.includes("SELECT COUNT(*)::text")) return { rows: [{ count: "0" }] };
      return { rows: [] };
    });
    const registry = new PostgresChatPresenceRegistry("node-a");

    await expect(registry.sweepExpired()).resolves.toEqual([{ userId: 7, online: false }]);

    const calls = mocks.clientQuery.mock.calls.map((call) => String(call[0]));
    const userLock = calls.findIndex((sql) => sql.includes("pg_advisory_xact_lock($1::bigint)"));
    const expiredDelete = calls.findIndex((sql) => sql.includes("DELETE FROM public.realtime_chat_presence"));
    expect(userLock).toBeGreaterThan(-1);
    expect(expiredDelete).toBeGreaterThan(userLock);
    expect(calls.filter((sql) => sql.includes("pg_notify('cerp_realtime_control'"))).toHaveLength(1);
    expect(mocks.clientRelease).toHaveBeenCalledOnce();
  });

  it("does not publish stale offline after a concurrent refresh removed the expired candidate", async () => {
    mocks.clientQuery.mockImplementation(async (statement: unknown) => {
      const sql = String(statement);
      if (sql.includes("SELECT DISTINCT user_id::text")) return { rows: [{ user_id: "9" }] };
      if (sql.includes("DELETE FROM public.realtime_chat_presence")) return { rows: [], rowCount: 0 };
      return { rows: [] };
    });
    const registry = new PostgresChatPresenceRegistry("node-a");

    await expect(registry.sweepExpired()).resolves.toEqual([]);
    const calls = mocks.clientQuery.mock.calls.map((call) => String(call[0]));
    expect(calls.some((sql) => sql.includes("SELECT COUNT(*)::text"))).toBe(false);
    expect(calls.some((sql) => sql.includes("pg_notify('cerp_realtime_control'"))).toBe(false);
  });
});
