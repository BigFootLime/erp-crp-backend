import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../config/database", () => ({ default: { query: vi.fn() } }));
vi.mock("../../../shared/realtime/realtime-outbox-transaction", () => ({ withRealtimeOutboxTransaction: vi.fn() }));
vi.mock("../../audit-logs/repository/audit-logs.repository", () => ({ repoInsertAuditLog: vi.fn() }));
vi.mock("./avatar.repository", () => ({ readUserAvatar: vi.fn() }));

import { readDirectorySelfProfile } from "./self-profile.repository";

const projectedRow = {
  id: 42,
  username: "fixture.directory",
  name: "Fixture",
  surname: "Directory",
  email: "fixture@example.test",
  tel_no: "+33000000000",
  job_title: "Test",
  employment_type: "CDI",
  weekly_hours_target: 35,
};

function client(rows: unknown[]) {
  const query = vi.fn().mockResolvedValue({ rows });
  return { query, tx: { query } as Pick<PoolClient, "query"> };
}

describe("readDirectorySelfProfile", () => {
  it("returns only the explicit directory identity projection with a parameterized actor id", async () => {
    const { query, tx } = client([projectedRow]);

    await expect(readDirectorySelfProfile(42, tx)).resolves.toEqual(projectedRow);

    expect(query).toHaveBeenCalledWith(expect.stringContaining("FROM public.users u WHERE u.id=$1"), [42]);
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain("u.directory_profile_id IS NOT NULL");
    expect(sql).not.toContain("to_jsonb(");
    expect(sql).not.toMatch(/\b(password|password_hash|mfa|directory_session|refresh_token|api_key)\b/i);
  });

  it("fails closed when the active directory projection is absent", async () => {
    const { tx } = client([]);

    await expect(readDirectorySelfProfile(42, tx)).rejects.toMatchObject({
      status: 403,
      code: "PROFILE_UNAVAILABLE",
    });
  });

  it("propagates a database error without substituting a legacy profile", async () => {
    const query = vi.fn().mockRejectedValue(Object.assign(new Error("permission denied"), { code: "42501" }));

    await expect(readDirectorySelfProfile(42, { query } as Pick<PoolClient, "query">)).rejects.toMatchObject({
      code: "42501",
    });
    expect(query).toHaveBeenCalledOnce();
  });
});
