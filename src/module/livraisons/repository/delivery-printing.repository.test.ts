import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => {
  const query = vi.fn()
  const release = vi.fn()
  return { query, release, client: { query, release }, enqueue: vi.fn(), audit: vi.fn() }
})

vi.mock("../../../config/database", () => ({
  default: { connect: vi.fn(async () => mocks.client), query: mocks.query },
}))
vi.mock("../../../shared/realtime/realtime-outbox.service", () => ({ enqueueEntityChanged: mocks.enqueue }))
vi.mock("../../audit-logs/repository/audit-logs.repository", () => ({ repoInsertAuditLog: mocks.audit }))

import { repoRetryLivraisonPrint } from "./livraisons.repository"

beforeEach(() => {
  vi.clearAllMocks()
  mocks.query.mockImplementation(async (sql: string) => {
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] }
    if (sql.includes("SELECT statut")) return { rows: [{ statut: "SHIPPED" }] }
    if (sql.includes("FROM public.delivery_outbox")) return { rows: [] }
    if (sql.includes("INSERT INTO public.delivery_outbox")) return { rows: [{ id: "outbox-1", requested_at: "2026-11-14T00:00:00.000Z" }] }
    if (sql.includes("INSERT INTO bon_livraison_event_log")) return { rows: [{ id: "event-1", created_at: "2026-11-14T00:00:01.000Z" }] }
    throw new Error(`Unexpected SQL: ${sql}`)
  })
})

describe("delivery printing facade", () => {
  it("preserves the retry transaction, event, audit and commit order through the public facade", async () => {
    await expect(repoRetryLivraisonPrint({ bon_livraison_id: "bl-1", user_id: 7 })).resolves.toEqual({
      bon_livraison_id: "bl-1", printing_status: "PENDING", print_retry_available: true,
      outbox_id: "outbox-1", attempts: 0, last_requested_at: "2026-11-14T00:00:00.000Z",
    })
    const statements = mocks.query.mock.calls.map(([sql]) => sql)
    expect(statements[0]).toBe("BEGIN")
    expect(statements.at(-1)).toBe("COMMIT")
    expect(statements.findIndex((sql) => sql.includes("INSERT INTO public.delivery_outbox")))
      .toBeLessThan(statements.findIndex((sql) => sql.includes("INSERT INTO bon_livraison_event_log")))
    expect(mocks.enqueue).toHaveBeenCalledOnce()
    expect(mocks.audit).toHaveBeenCalledOnce()
    expect(mocks.enqueue).toHaveBeenCalledWith(mocks.client, expect.any(Object), expect.any(Object))
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ tx: mocks.client }))
    expect(mocks.release).toHaveBeenCalledOnce()
  })

  it("resets an existing outbox retry timestamp through the public facade", async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] }
      if (sql.includes("SELECT statut")) return { rows: [{ statut: "SHIPPED" }] }
      if (sql.includes("FROM public.delivery_outbox")) return { rows: [{ id: "outbox-old" }] }
      if (sql.includes("UPDATE public.delivery_outbox")) return { rows: [{ id: "outbox-old", requested_at: "2026-11-14T00:00:00.000Z" }] }
      if (sql.includes("INSERT INTO bon_livraison_event_log")) return { rows: [{ id: "event-1" }] }
      throw new Error(`Unexpected SQL: ${sql}`)
    })
    await repoRetryLivraisonPrint({ bon_livraison_id: "bl-1", user_id: 7 })
    const update = mocks.query.mock.calls.find(([sql]) => sql.includes("UPDATE public.delivery_outbox"))!
    expect(update[0]).toContain("requested_at = now()")
    expect(update[0]).toContain("published_at = NULL")
    expect(update[1]).toEqual(["outbox-old", expect.any(String)])
    expect(mocks.query.mock.calls.map(([sql]) => sql)).toContain("COMMIT")
  })

  it.each([
    ["realtime enqueue", () => mocks.enqueue.mockRejectedValueOnce(new Error("enqueue unavailable")), "enqueue unavailable"],
    ["audit", () => mocks.audit.mockRejectedValueOnce(new Error("audit unavailable")), "audit unavailable"],
  ])("rolls back without committing when %s fails", async (_label, fail, message) => {
    fail()
    await expect(repoRetryLivraisonPrint({ bon_livraison_id: "bl-1", user_id: 7 })).rejects.toThrow(message)
    const statements = mocks.query.mock.calls.map(([sql]) => sql)
    expect(statements[0]).toBe("BEGIN")
    expect(statements).toContain("ROLLBACK")
    expect(statements).not.toContain("COMMIT")
    expect(mocks.release).toHaveBeenCalledOnce()
  })

  it("rolls back and releases the same client when a query fails after BEGIN", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] }).mockRejectedValueOnce(new Error("header query unavailable"))
    await expect(repoRetryLivraisonPrint({ bon_livraison_id: "bl-1", user_id: 7 })).rejects.toThrow("header query unavailable")
    expect(mocks.query.mock.calls.map(([sql]) => sql)).toEqual(["BEGIN", expect.stringContaining("SELECT statut"), "ROLLBACK"])
    expect(mocks.release).toHaveBeenCalledOnce()
  })
})
