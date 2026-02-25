import { describe, it, expect, vi } from "vitest"
import type { PoolClient } from "pg"

import { repoGetMetrologieBlockState } from "../module/metrologie/repository/metrologie.repository"

describe("repoGetMetrologieBlockState", () => {
  it("returns disabled when setting missing", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [] })
    const q = { query } as unknown as Pick<PoolClient, "query">

    const out = await repoGetMetrologieBlockState(q)

    expect(out).toEqual({ enabled: false, overdue_critical: 0 })
    expect(query).toHaveBeenCalledTimes(1)
    expect(String(query.mock.calls[0]?.[0])).toContain("FROM public.erp_settings")
  })

  it("returns enabled + overdue count when enabled", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ value_json: { enabled: true } }] })
      .mockResolvedValueOnce({ rows: [{ total: 2 }] })
    const q = { query } as unknown as Pick<PoolClient, "query">

    const out = await repoGetMetrologieBlockState(q)

    expect(out).toEqual({ enabled: true, overdue_critical: 2 })
    expect(query).toHaveBeenCalledTimes(2)
    expect(String(query.mock.calls[1]?.[0])).toContain("FROM public.metrologie_equipements")
  })

  it("fails closed when queries throw", async () => {
    const query = vi.fn().mockRejectedValueOnce(new Error("boom"))
    const q = { query } as unknown as Pick<PoolClient, "query">

    const out = await repoGetMetrologieBlockState(q)

    expect(out).toEqual({ enabled: false, overdue_critical: 0 })
  })
})
