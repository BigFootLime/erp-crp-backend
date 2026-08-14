import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
}));

vi.mock("../../../config/database", () => ({
  default: { query: mocks.query },
}));

import { repoWorklist } from "./station.repository";

describe("repoWorklist", () => {
  beforeEach(() => {
    mocks.query.mockReset().mockResolvedValue({ rows: [] });
  });

  it("binds every PostgreSQL parameter with a deterministic type", async () => {
    await repoWorklist({
      machineId: null,
      workshopZone: null,
      q: null,
      machineOnly: false,
      includeBlocked: true,
      limit: 50,
    });

    const [sql, values] = mocks.query.mock.calls[0] as [string, unknown[]];
    expect(values).toEqual([null, null, null, false, 50]);
    expect(sql).toContain("$1::uuid");
    expect(sql).toContain("$2::text");
    expect(sql).toContain("$3::text");
    expect(sql).toContain("$4::boolean");
    expect(sql).toContain("LIMIT $5");
    expect(sql).not.toMatch(/\$6\b/);
  });
});
