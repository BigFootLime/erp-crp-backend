import { beforeEach, describe, expect, it, vi } from "vitest";

const { connect, poolQuery, insertAuditLog } = vi.hoisted(() => ({
  connect: vi.fn(),
  poolQuery: vi.fn(),
  insertAuditLog: vi.fn(),
}));

vi.mock("../config/database", () => ({
  default: { connect, query: poolQuery },
}));

vi.mock("../module/audit-logs/repository/audit-logs.repository", () => ({
  repoInsertAuditLog: insertAuditLog,
}));

import { repoProvisionUser } from "../module/admin/repository/admin.repository";

const createdUser = {
  id: 42,
  username: "COMPTE.INTERNE",
  name: "Compte",
  surname: "Interne",
  email: "compte.interne@example.test",
  tel_no: null,
  role: "Employee",
  gender: null,
  address: null,
  lane: null,
  house_no: null,
  postcode: null,
  country: "France",
  salary: null,
  date_of_birth: null,
  employment_date: null,
  employment_end_date: null,
  national_id: null,
  profile_picture: null,
  last_login: null,
  status: "Inactive",
  created_at: "2026-08-03T00:00:00.000Z",
  social_security_number: null,
};

const input = {
  actorUserId: 7,
  idempotencyKey: "7eb84d7e-9df1-4ee7-a8e9-3ee6c85b2bee",
  requestHash: "a".repeat(64),
  passwordHash: "bcrypt-hash",
  username: createdUser.username,
  name: createdUser.name,
  surname: createdUser.surname,
  email: createdUser.email,
  role: createdUser.role,
  roles: [createdUser.role],
  assignedBy: 7,
  status: createdUser.status,
};

function makeClient(query: ReturnType<typeof vi.fn>) {
  return { query, release: vi.fn() };
}

describe("administrative user provisioning repository", () => {
  beforeEach(() => {
    connect.mockReset();
    poolQuery.mockReset().mockImplementation(async (sql: string) => {
      if (sql.includes("WHERE is_superadmin")) return { rows: [] };
      if (sql.includes("FROM public.users u")) {
        return {
          rows: [{
            ...createdUser,
            roles: [createdUser.role],
            profile_incomplete: true,
          }],
        };
      }
      return { rows: [] };
    });
    insertAuditLog.mockReset().mockResolvedValue(undefined);
  });

  it("commits the account and a PII-minimized audit in the same transaction", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("INSERT INTO public.admin_user_provisioning_requests")) {
        return { rowCount: 1, rows: [{ idempotency_key: input.idempotencyKey }] };
      }
      if (sql.includes("INSERT INTO public.users")) return { rows: [createdUser] };
      if (sql.includes("realtime_session_epochs")) return { rows: [{ session_epoch: "1" }] };
      if (sql.includes("realtime_authorization_epoch")) return { rows: [{ epoch: "1" }] };
      return { rowCount: 1, rows: [] };
    });
    const client = makeClient(query);
    connect.mockResolvedValue(client);

    const result = await repoProvisionUser(input);

    expect(result).toMatchObject({ user: { id: 42, status: "Inactive" }, replayed: false });
    expect(insertAuditLog).toHaveBeenCalledOnce();
    const audit = insertAuditLog.mock.calls[0]?.[0];
    expect(audit.tx).toBe(client);
    expect(audit).toMatchObject({
      ip: null,
      user_agent: null,
      device_type: null,
      os: null,
      browser: null,
    });
    expect(audit.body).toMatchObject({
      action: "ADMIN_USER_PROVISIONED",
      entity_id: "42",
      details: { role: "Employee", status: "Inactive", profile_incomplete: true },
    });
    expect(JSON.stringify(audit.body.details)).not.toContain(createdUser.email);
    expect(query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
  });

  it("returns a generic conflict and rolls back on a duplicate account", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("INSERT INTO public.admin_user_provisioning_requests")) {
        return { rowCount: 1, rows: [{ idempotency_key: input.idempotencyKey }] };
      }
      if (sql.includes("INSERT INTO public.users")) {
        throw { code: "23505", constraint: "users_email_key" };
      }
      return { rowCount: 1, rows: [] };
    });
    const client = makeClient(query);
    connect.mockResolvedValue(client);

    await expect(repoProvisionUser(input)).rejects.toMatchObject({
      status: 409,
      code: "ACCOUNT_CONFLICT",
      message: "Impossible de provisionner ce compte avec ces informations.",
    });
    expect(query).toHaveBeenCalledWith("ROLLBACK");
    expect(insertAuditLog).not.toHaveBeenCalled();
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("replays the winning transaction without creating or auditing twice", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("INSERT INTO public.admin_user_provisioning_requests")) {
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes("FROM public.admin_user_provisioning_requests")) {
        return {
          rows: [{
            actor_user_id: input.actorUserId,
            request_hash: input.requestHash,
            user_id: createdUser.id,
          }],
        };
      }
      return { rowCount: 1, rows: [] };
    });
    const client = makeClient(query);
    connect.mockResolvedValue(client);

    const result = await repoProvisionUser(input);

    expect(result).toMatchObject({ user: { id: 42 }, replayed: true });
    expect(query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO public.users"))).toBe(false);
    expect(insertAuditLog).not.toHaveBeenCalled();
    expect(query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
  });
});
