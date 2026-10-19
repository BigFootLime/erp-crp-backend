import { describe, expect, it, vi } from "vitest";

import { repoGetAccessUser, repoListAccessUsers, type DbQueryer } from "./access-control.repository";

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
});
