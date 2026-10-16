import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  directory: vi.fn(),
}));

vi.mock("../../../config/database", () => ({ default: { connect: mocks.connect } }));
vi.mock("../../../shared-directory/site-runtime", () => ({ sharedDirectoryClient: mocks.directory }));

import { repoUpdateUser } from "./admin.repository";

describe("repoUpdateUser directory owner status backstop", () => {
  beforeEach(() => vi.resetAllMocks());

  it("uses its transaction client to lock and reject a Production owner before the user write", async () => {
    const statements: string[] = [];
    const tx = {
      query: vi.fn(async (sql: string) => {
        statements.push(sql);
        if (sql === "BEGIN" || sql === "ROLLBACK") return { rows: [] };
        if (sql.includes("to_regclass('public.cerp_directory_memberships')")) return { rows: [{ installed: true }] };
        if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
        if (sql.includes("FROM public.cerp_directory_memberships")) return { rows: [{ owner: 1 }] };
        throw new Error(`unexpected query: ${sql}`);
      }),
      release: vi.fn(),
    };
    mocks.connect.mockResolvedValue(tx);

    await expect(repoUpdateUser(42, { status: "Inactive" }, 7)).rejects.toMatchObject({
      status: 409,
      code: "DIRECTORY_OWNER_STATUS_MANAGED",
    });

    expect(mocks.connect).toHaveBeenCalledTimes(1);
    expect(statements[0]).toBe("BEGIN");
    expect(statements[1]).toContain("to_regclass('public.cerp_directory_memberships')");
    expect(statements[2]).toContain("pg_advisory_xact_lock");
    expect(statements[3]).toContain("FOR UPDATE OF m,u");
    expect(statements[4]).toBe("ROLLBACK");
    expect(statements.some((sql) => sql.includes("UPDATE public.users SET"))).toBe(false);
    expect(tx.release).toHaveBeenCalledOnce();
  });
});
