import { beforeEach, describe, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({ query: vi.fn(), release: vi.fn(), connect: vi.fn(), audit: vi.fn() }))
vi.mock("../config/database", () => ({ default: { connect: mocks.connect } }))
vi.mock("../shared/codes/code-generator.service", () => ({ generatePieceTechniqueBusinessCode: vi.fn().mockResolvedValue("PLAN-C") }))
vi.mock("../module/gammes/repository/gammes.repository", () => ({ copyGammeOperationsTx: vi.fn().mockResolvedValue(2) }))
vi.mock("../module/pieces-techniques/services/document-policy.service", () => ({ freezePieceVersionRequirements: vi.fn() }))
vi.mock("../module/audit-logs/repository/audit-logs.repository", () => ({ repoInsertAuditLog: mocks.audit }))
import { repoCreateNextVersion } from "../module/pieces-techniques/repository/versions.repository"

const audit = { user_id: 42, ip: null, user_agent: null, device_type: null, os: null, browser: null, path: "/test", page_key: "pieces", client_session_id: null }
beforeEach(() => {
  vi.clearAllMocks()
  mocks.connect.mockResolvedValue({ query: mocks.query, release: mocks.release })
  mocks.query.mockImplementation(async (sql: string) => {
    if (sql.includes("SELECT id::text AS id, plan_reference")) return { rows: [{ id: "source", plan_reference: "PLAN", manufacturing_mode: "ASSEMBLY", assembly_supply_strategy: "MAKE_TO_ORDER" }], rowCount: 1 }
    if (sql.includes("SELECT client_id")) return { rows: [{ client_id: null, code_client: "001" }], rowCount: 1 }
    if (sql.includes("INSERT INTO public.piece_technique_versions")) return { rows: [{ id: "new", indice: "C", type_changement: "EVOLUTION" }], rowCount: 1 }
    if (sql.includes("INSERT INTO public.pieces_techniques_nomenclature")) return { rows: [], rowCount: 2 }
    return { rows: [], rowCount: 0 }
  })
})

describe("#755 — clonage d'assemblage", () => {
  it("attribue la nomenclature à la nouvelle version et conserve son audit dans la transaction", async () => {
    const result = await repoCreateNextVersion("piece", "source", { indice: "C" }, audit)
    expect(result.copied.version_nomenclature_lines).toBe(2)
    const copy = mocks.query.mock.calls.find(([sql]) => sql.includes("INSERT INTO public.pieces_techniques_nomenclature"))!
    expect(copy[1]).toEqual(["piece", "new", "source"])
    const lockIndex = mocks.query.mock.calls.findIndex(([sql]) => sql.includes("pg_advisory_xact_lock"))
    expect(lockIndex).toBeGreaterThan(0)
    expect(lockIndex).toBeLessThan(mocks.query.mock.calls.indexOf(copy))
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ tx: expect.anything(), body: expect.objectContaining({ entity_id: "new", details: expect.objectContaining({ source_version_id: "source", copied: expect.objectContaining({ version_nomenclature_lines: 2 }) }) }) }))
    expect(mocks.query).toHaveBeenLastCalledWith("COMMIT")
    expect(mocks.release).toHaveBeenCalledOnce()
  })
  it("annule intégralement la copie et ne prétend pas qu'un indice existe si la nomenclature refuse l'écriture", async () => {
    const normal = mocks.query.getMockImplementation()!
    mocks.query.mockImplementation((sql: string, params?: unknown[]) => sql.includes("INSERT INTO public.pieces_techniques_nomenclature")
      ? Promise.reject(Object.assign(new Error("duplicate BOM rank"), { code: "23505", constraint: "ux_ptec_nom_parent_rang" }))
      : normal(sql, params))
    await expect(repoCreateNextVersion("piece", "source", { indice: "C" }, audit)).rejects.toMatchObject({ status: 409, message: expect.not.stringContaining("Cet indice existe déjà") })
    expect(mocks.query).toHaveBeenLastCalledWith("ROLLBACK")
    expect(mocks.query).not.toHaveBeenCalledWith("COMMIT")
    expect(mocks.audit).not.toHaveBeenCalled()
    expect(mocks.release).toHaveBeenCalledOnce()
  })
})
