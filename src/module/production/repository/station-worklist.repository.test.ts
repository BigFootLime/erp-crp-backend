import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
}));

vi.mock("../../../config/database", () => ({
  default: { query: mocks.query },
}));

import { repoResolveScan, repoWorklist } from "./station.repository";

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
    expect(values).toEqual([null, null, null, false, 50, false]);
    expect(sql).toContain("$1::uuid");
    expect(sql).toContain("$2::text");
    expect(sql).toContain("$3::text");
    expect(sql).toContain("$4::boolean");
    expect(sql).toContain("LIMIT $5");
    expect(sql).toContain('$6::boolean');
  });
  it('applies the prepared material operation filter before the candidate limit',async()=>{
    await repoWorklist({machineId:null,workshopZone:null,q:null,machineOnly:false,includeBlocked:true,materialOnly:true,limit:30});
    const [sql,values]=mocks.query.mock.calls[0] as [string,unknown[]];
    expect(values[5]).toBe(true);
    expect(sql.indexOf("mn.technical_version_id=o.piece_technique_version_id")).toBeLessThan(sql.indexOf('LIMIT 500'));
  });
  it('resolves an OF scan only against prepared material operations in cutting mode', async () => {
    await repoResolveScan('OF-2026-0007', true);
    const [sql, values] = mocks.query.mock.calls[0] as [string, unknown[]];
    expect(values).toEqual(['OF-2026-0007', null, null, true]);
    expect(sql.match(/mn\.technical_version_id=o\.piece_technique_version_id/g)).toHaveLength(2);
    expect(sql.match(/NOT \$4::boolean/g)).toHaveLength(2);
  });
});
