import { describe, expect, it, vi } from "vitest";

import { repoGetAccessUser, repoListAccessUsers, type DbQueryer } from "./access-control.repository";
import { repoListReviewCandidates } from "./access-review.repository";
import { repoGetAdminAnalytics } from "../../admin/repository/admin.repository";
import { retiredAccountPredicate } from "../../auth/domain/account-retirement";

const { poolQuery } = vi.hoisted(() => ({ poolQuery: vi.fn() }));
vi.mock("../../../config/database", () => ({ default: { query: poolQuery } }));

const activeInactiveUser = {
  id: 7,
  username: "INACTIF",
  name: null,
  surname: null,
  email: null,
  role: "Employee",
  roles: ["Employee"],
  status: "Inactive",
  is_superadmin: false,
  last_login: null,
};

describe("access-control retired account visibility", () => {
  it("keeps an ordinary inactive account listable while applying the exact retirement marker", async () => {
    const statements: string[] = [];
    const queryMock = vi.fn(async (sql: unknown) => {
      statements.push(String(sql));
      return { rows: [activeInactiveUser] };
    });
    const query = queryMock as unknown as DbQueryer["query"];

    await expect(repoListAccessUsers({ query })).resolves.toEqual([activeInactiveUser]);

    const statement = statements[0] ?? "";
    expect(statement).toContain("to_jsonb(u)");
    expect(statement).toContain("cerp_account_retirement");
    expect(statement).toContain("schema_version");
    expect(statement).toContain("IS DISTINCT FROM '1'::jsonb");
  });

  it("queries a retired target as absent rather than exposing it to an access mutation", async () => {
    const statements: string[] = [];
    const paramsSeen: unknown[][] = [];
    const queryMock = vi.fn(async (sql: unknown, params?: unknown[]) => {
      statements.push(String(sql));
      paramsSeen.push(params ?? []);
      return { rows: [] };
    });
    const query = queryMock as unknown as DbQueryer["query"];

    await expect(repoGetAccessUser(17, { query })).resolves.toBeNull();

    expect(statements[0]).toContain("to_jsonb(u)");
    expect(paramsSeen[0]).toEqual([17]);
  });

  it("excludes retired identities from new review snapshots while retaining ordinary inactive candidates", async () => {
    const queryMock = vi.fn(async () => ({ rows: [{
      user_id: 7, username: "INACTIF", status: "Inactive", roles: ["Employee"],
      is_superadmin: false, last_activity_at: null, failed_login_count: 0,
      last_failed_login_at: null, exceptional_module_keys: [], inactive: true,
    }] }));
    const query = queryMock as unknown as DbQueryer["query"];

    const result = await repoListReviewCandidates({ query }, {
      inactivity_cutoff: "2026-10-01T00:00:00Z",
      login_failure_cutoff: "2026-10-01T00:00:00Z",
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ user_id: 7, status: "Inactive", inactive: true });
    const sql = String((queryMock.mock.calls[0] as unknown[] | undefined)?.[0]);
    expect(sql).toContain(`WHERE ${retiredAccountPredicate("u")}\n     ORDER BY u.username`);
  });

  it("counts operational users without suppressing historical authentication statistics", async () => {
    poolQuery.mockReset();
    poolQuery.mockResolvedValueOnce({ rows: [{ total: 1, active: 1, blocked: 0 }] });
    poolQuery.mockResolvedValueOnce({ rows: [{ logins30d: 18, failed30d: 3 }] });
    poolQuery.mockResolvedValueOnce({ rows: [{ date: "2026-10-19", count: 18 }] });
    poolQuery.mockResolvedValueOnce({ rows: [{ date: "2026-10-19", count: 3 }] });

    const result = await repoGetAdminAnalytics({ from: "", to: "", success: "", role: "", status: "" });

    expect(result.kpis).toEqual({ totalUsers: 1, activeUsers: 1, blockedUsers: 0, logins30d: 18, failedLogins30d: 3 });
    expect(String(poolQuery.mock.calls[0]?.[0])).toContain(`WHERE ${retiredAccountPredicate("users")}`);
    for (const [sql] of poolQuery.mock.calls.slice(1)) {
      expect(String(sql)).not.toContain("cerp_account_retirement");
    }
  });
});
