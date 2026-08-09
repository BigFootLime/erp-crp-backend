import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ connect: vi.fn(), audit: vi.fn() }));
vi.mock("../config/database", () => ({ default: { connect: mocks.connect } }));
vi.mock("../module/audit-logs/repository/audit-logs.repository", () => ({ repoInsertAuditLog: mocks.audit }));

import { repoActivateAccountInvitation } from "../module/auth/repository/account-invitation.repository";

const base = {
  invitation_id: "11111111-1111-4111-8111-111111111111",
  user_id: 42,
  created_by: 4,
  token_hash: "b".repeat(64),
  expires_at: "2099-08-10T20:00:00.000Z",
  accepted_at: null,
  revoked_at: null,
  status: "Inactive",
};
const input = {
  invitationId: base.invitation_id,
  userId: 42,
  tokenHash: base.token_hash,
  passwordHash: "bcrypt-hash",
  meta: { ip: "127.0.0.1", user_agent: null, device_type: null, os: null, browser: null },
};

function makeClient(row: typeof base, consumed = 1) {
  const query = vi.fn(async (sql: unknown) => {
    const statement = String(sql);
    if (statement.includes("FROM public.admin_account_invitations") && statement.includes("FOR UPDATE")) {
      return { rows: [row] };
    }
    if (statement.includes("SET accepted_at")) return { rows: [], rowCount: consumed };
    if (statement.includes("realtime_session_epochs")) return { rows: [{ session_epoch: "1" }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  });
  return { query, release: vi.fn() };
}

describe("account invitation activation transaction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.audit.mockResolvedValue(null);
  });

  it("activates, hashes the password upstream and audits the invited actor atomically", async () => {
    const client = makeClient(base);
    mocks.connect.mockResolvedValueOnce(client);

    await expect(repoActivateAccountInvitation(input)).resolves.toEqual({ userId: 42, replayed: false });
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining("SET password = $1, status = 'Active'"),
      ["bcrypt-hash", 42],
    );
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({
      user_id: 42,
      tx: client,
      body: expect.objectContaining({ action: "ADMIN_USER_ACTIVATED" }),
    }));
    expect(client.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
  });

  it("returns a safe replay without changing the password twice", async () => {
    const client = makeClient({ ...base, accepted_at: "2026-08-09T21:00:00.000Z", status: "Active" });
    mocks.connect.mockResolvedValueOnce(client);

    await expect(repoActivateAccountInvitation(input)).resolves.toEqual({ userId: 42, replayed: true });
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("SET password"))).toBe(false);
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("rejects an expired invitation and rolls back", async () => {
    const client = makeClient({ ...base, expires_at: "2020-01-01T00:00:00.000Z" });
    mocks.connect.mockResolvedValueOnce(client);

    await expect(repoActivateAccountInvitation(input)).rejects.toMatchObject({
      status: 400,
      code: "INVITATION_EXPIRED",
    });
    expect(client.query).toHaveBeenCalledWith("ROLLBACK");
    expect(mocks.audit).not.toHaveBeenCalled();
  });
});
