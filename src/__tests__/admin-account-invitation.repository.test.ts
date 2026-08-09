import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  poolQuery: vi.fn(),
  audit: vi.fn(),
}));

vi.mock("../config/database", () => ({ default: { connect: mocks.connect, query: mocks.poolQuery } }));
vi.mock("../module/audit-logs/repository/audit-logs.repository", () => ({ repoInsertAuditLog: mocks.audit }));

import { repoCreateAccountInvitation } from "../module/admin/repository/admin.repository";

const invitation = {
  id: "11111111-1111-4111-8111-111111111111",
  user_id: 42,
  username: "INVITED.USER",
  created_by: 4,
  idempotency_key: "22222222-2222-4222-8222-222222222222",
  request_hash: "a".repeat(64),
  token_hash: "b".repeat(64),
  created_at: "2026-08-09T20:00:00.000Z",
  expires_at: "2026-08-10T20:00:00.000Z",
  accepted_at: null,
  revoked_at: null,
};
const input = {
  id: invitation.id,
  userId: invitation.user_id,
  actorUserId: invitation.created_by,
  idempotencyKey: invitation.idempotency_key,
  requestHash: invitation.request_hash,
  tokenHash: invitation.token_hash,
  createdAt: invitation.created_at,
  expiresAt: invitation.expires_at,
};

function client(query: ReturnType<typeof vi.fn>) {
  return { query, release: vi.fn() };
}

describe("administrative account invitation repository", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.audit.mockResolvedValue(null);
  });

  it("writes the one-use invitation and actor audit in one transaction", async () => {
    const query = vi.fn(async (sql: unknown) => {
      const statement = String(sql);
      if (statement.includes("FROM public.users") && statement.includes("FOR UPDATE")) {
        return { rows: [{ id: 42, username: invitation.username, status: "Inactive" }] };
      }
      if (statement.includes("WHERE invitation.created_by")) return { rows: [] };
      if (statement.includes("INSERT INTO public.admin_account_invitations")) return { rows: [invitation], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });
    const tx = client(query);
    mocks.connect.mockResolvedValueOnce(tx);

    await expect(repoCreateAccountInvitation(input)).resolves.toEqual({ invitation, replayed: false });
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({
      user_id: 4,
      tx,
      body: expect.objectContaining({ action: "ADMIN_USER_INVITED", entity_id: "42" }),
    }));
    expect(query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
  });

  it("replays a duplicate request without a second insert or audit", async () => {
    const query = vi.fn(async (sql: unknown) => {
      const statement = String(sql);
      if (statement.includes("FROM public.users") && statement.includes("FOR UPDATE")) {
        return { rows: [{ id: 42, username: invitation.username, status: "Inactive" }] };
      }
      if (statement.includes("WHERE invitation.created_by")) return { rows: [invitation] };
      return { rows: [], rowCount: 1 };
    });
    mocks.connect.mockResolvedValueOnce(client(query));

    await expect(repoCreateAccountInvitation(input)).resolves.toEqual({ invitation, replayed: true });
    expect(query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO public.admin_account_invitations"))).toBe(false);
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("recovers a committed result after the COMMIT acknowledgement is lost", async () => {
    const query = vi.fn(async (sql: unknown) => {
      const statement = String(sql);
      if (statement === "COMMIT") throw new Error("connection lost after commit");
      if (statement.includes("FROM public.users") && statement.includes("FOR UPDATE")) {
        return { rows: [{ id: 42, username: invitation.username, status: "Inactive" }] };
      }
      if (statement.includes("WHERE invitation.created_by")) return { rows: [] };
      if (statement.includes("INSERT INTO public.admin_account_invitations")) return { rows: [invitation], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });
    const verifierQuery = vi.fn(async (sql: unknown) => String(sql).includes("WHERE invitation.id")
      ? { rows: [invitation] }
      : { rows: [] });
    mocks.connect
      .mockResolvedValueOnce(client(query))
      .mockResolvedValueOnce(client(verifierQuery));

    await expect(repoCreateAccountInvitation(input)).resolves.toEqual({ invitation, replayed: false });
  });
});
