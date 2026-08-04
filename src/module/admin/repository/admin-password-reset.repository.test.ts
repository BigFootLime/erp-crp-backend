import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  query: vi.fn(),
}));

vi.mock("../../../config/database", () => ({
  default: { connect: mocks.connect, query: mocks.query },
}));

import { repoResetUserPasswordWithToken } from "./admin.repository";

const TOKEN = "one-use-admin-token";
const TOKEN_HASH = crypto.createHash("sha256").update(TOKEN).digest("hex");

type ClientState = {
  usedAt: string | null;
  password: string;
  epoch: number;
};

function makeClient(state: ClientState, options: { waitForFirstCommit?: Promise<void>; onCommit?: () => void } = {}) {
  let snapshotReads = 0;
  const release = vi.fn();
  const query = vi.fn(async (sql: unknown, params?: unknown[]) => {
    const statement = String(sql);
    if (statement.includes("FROM public.password_reset_tokens reset") && statement.includes("FOR UPDATE")) {
      await options.waitForFirstCommit;
      return {
        rows: [{
          id: "11111111-1111-4111-8111-111111111111",
          expires_at: "2099-08-04T10:00:00.000Z",
          used_at: state.usedAt,
        }],
        rowCount: 1,
      };
    }
    if (statement.includes("jsonb_build_object") && statement.includes("authorization_epoch")) {
      snapshotReads += 1;
      return {
        rows: [{
          user_state: { password: state.password, email: null },
          roles: ["Employee"],
          session_epoch: String(state.epoch),
          authorization_epoch: "2",
        }],
        rowCount: 1,
      };
    }
    if (statement.includes("UPDATE public.users SET password")) {
      state.password = String(params?.[0]);
      return { rows: [], rowCount: 1 };
    }
    if (statement.includes("WITH bumped AS") && statement.includes("realtime_session_epochs")) {
      state.epoch += 1;
      return { rows: [{ session_epoch: String(state.epoch) }], rowCount: 1 };
    }
    if (statement.includes("UPDATE public.password_reset_tokens")) {
      if (state.usedAt) return { rows: [], rowCount: 0 };
      state.usedAt = String(params?.[1]);
      return { rows: [], rowCount: 1 };
    }
    if (statement === "COMMIT") options.onCommit?.();
    return { rows: [], rowCount: 0 };
  });
  return { query, release, snapshotReads: () => snapshotReads };
}

describe("admin password reset transaction", () => {
  beforeEach(() => vi.clearAllMocks());

  it("resets an account without email in one token/password/epoch transaction", async () => {
    const state = { usedAt: null, password: "old-hash", epoch: 3 };
    const client = makeClient(state);
    mocks.connect.mockResolvedValueOnce(client);

    await expect(repoResetUserPasswordWithToken({
      userId: "7",
      rawToken: TOKEN,
      passwordHash: "new-hash",
    })).resolves.toBe(7);

    const statements = client.query.mock.calls.map(([sql]) => String(sql));
    expect(statements[0]).toBe("BEGIN");
    expect(statements.some((sql) => sql.includes("FOR UPDATE OF reset, users"))).toBe(true);
    expect(statements.some((sql) => sql.includes("UPDATE public.users SET password"))).toBe(true);
    expect(statements.some((sql) => sql.includes("UPDATE public.password_reset_tokens"))).toBe(true);
    expect(statements.at(-1)).toBe("COMMIT");
    expect(statements.some((sql) => /\bemail\b/i.test(sql) && !sql.includes("jsonb_build_object"))).toBe(false);
    expect(state).toMatchObject({ usedAt: expect.any(String), password: "new-hash", epoch: 4 });
    expect(client.snapshotReads()).toBe(2);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("serializes two uses and rejects the second after the first commits", async () => {
    const state = { usedAt: null, password: "old-hash", epoch: 3 };
    let releaseCommit!: () => void;
    const firstCommitted = new Promise<void>((resolve) => { releaseCommit = resolve; });
    const first = makeClient(state, { onCommit: releaseCommit });
    const second = makeClient(state, { waitForFirstCommit: firstCommitted });
    mocks.connect.mockResolvedValueOnce(first).mockResolvedValueOnce(second);

    const firstReset = repoResetUserPasswordWithToken({ userId: "7", rawToken: TOKEN, passwordHash: "new-a" });
    const secondReset = repoResetUserPasswordWithToken({ userId: "7", rawToken: TOKEN, passwordHash: "new-b" });

    await expect(firstReset).resolves.toBe(7);
    await expect(secondReset).rejects.toMatchObject({ status: 400, code: "RESET_TOKEN_USED" });
    expect(second.query).toHaveBeenCalledWith("ROLLBACK");
    expect(state.password).toBe("new-a");
    expect(state.epoch).toBe(4);
    expect(TOKEN_HASH).toMatch(/^[a-f0-9]{64}$/);
  });
});
