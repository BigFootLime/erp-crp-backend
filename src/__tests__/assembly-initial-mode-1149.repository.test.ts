import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ query: vi.fn(), release: vi.fn(), connect: vi.fn(), audit: vi.fn(), archive: vi.fn() }))
vi.mock("../config/database", () => ({ default: { connect: mocks.connect } }))
vi.mock("../shared/codes/code-generator.service", () => ({ generatePieceTechniqueBusinessCode: vi.fn().mockResolvedValue("001-PLAN-A") }))
vi.mock("../shared/authoritative-documents/authoritative-document.service", () => ({ queueCreationPdfArchive: mocks.archive }))
vi.mock("../module/audit-logs/repository/audit-logs.repository", () => ({ repoInsertAuditLog: mocks.audit }))
import { repoCreatePieceTechnique } from "../module/pieces-techniques/repository/pieces-techniques.repository"
import { repoCreateVersion, repoUpdateVersion } from "../module/pieces-techniques/repository/versions.repository"

const audit = { user_id: 42, ip: null, user_agent: null, device_type: null, os: null, browser: null, path: "/test", page_key: "pieces", client_session_id: null }
let ensemble = false
let current = { id: "version-a", indice: "A", statut: "BROUILLON", manufacturing_mode: "SIMPLE", assembly_supply_strategy: "MAKE_TO_ORDER", updated_at: "2026-10-11 03:30:00+00", change_level: "MAJOR" }
beforeEach(() => {
  vi.clearAllMocks()
  ensemble = false
  current = { id: "version-a", indice: "A", statut: "BROUILLON", manufacturing_mode: "SIMPLE", assembly_supply_strategy: "MAKE_TO_ORDER", updated_at: "2026-10-11 03:30:00+00", change_level: "MAJOR" }
  mocks.connect.mockResolvedValue({ query: mocks.query, release: mocks.release })
  mocks.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (sql.includes("INSERT INTO pieces_techniques (")) return { rows: [{
      id: params[0], client_id: "001", root_piece_technique_id: params[0], version_number: 1,
      code_piece: "001-PLAN-A", name_piece: "Montage", designation: "Montage", statut: "DRAFT",
      prix_unitaire: 0, en_fabrication: 0, ensemble, created_at: current.updated_at, updated_at: current.updated_at,
    }], rowCount: 1 }
    if (sql.includes("SELECT ensemble")) return { rows: [{ ensemble }], rowCount: 1 }
    if (sql.includes("SELECT client_id")) return { rows: [{ client_id: "001", code_client: "001" }], rowCount: 1 }
    if (sql.includes("FROM public.piece_technique_versions") && sql.includes("FOR UPDATE")) return { rows: [current], rowCount: 1 }
    if (sql.includes("INSERT INTO public.piece_technique_versions")) return { rows: [{ ...current, manufacturing_mode: params[12] ?? params[9] }], rowCount: 1 }
    if (sql.includes("UPDATE public.piece_technique_versions")) return { rows: [{ ...current, manufacturing_mode: params[0], assembly_supply_strategy: params[1] }], rowCount: 1 }
    return { rows: [], rowCount: 0 }
  })
})

describe("#1149 — mode initial et correction du brouillon", () => {
  it.each([false, true])("crée le premier indice avec le type choisi (ensemble=%s)", async (isAssembly) => {
    ensemble = isAssembly
    await repoCreatePieceTechnique({ name_piece: "Montage", designation: "Montage", plan_reference: "PLAN", indice_externe: "A", client_name: "Recette", prix_unitaire: 0, statut: "DRAFT", en_fabrication: false, ensemble, bom: [], operations: [], achats: [] }, audit)
    const insert = mocks.query.mock.calls.find(([sql]) => sql.includes("INSERT INTO public.piece_technique_versions"))!
    expect(insert[0]).toContain("manufacturing_mode, assembly_supply_strategy")
    expect(insert[1][9]).toBe(isAssembly ? "ASSEMBLY" : "SIMPLE")
    expect(insert[0]).toContain("'MAKE_TO_ORDER'")
    expect(mocks.query).toHaveBeenLastCalledWith("COMMIT")
    expect(mocks.archive).toHaveBeenCalledOnce()
  })

  it.each([false, true])("déduit le mode du parent si l’API de premier indice ne le précise pas (ensemble=%s)", async (isAssembly) => {
    ensemble = isAssembly
    await repoCreateVersion("piece", { indice: "A", plan_reference: "PLAN" }, audit)
    const insert = mocks.query.mock.calls.find(([sql]) => sql.includes("INSERT INTO public.piece_technique_versions"))!
    expect(insert[1][12]).toBe(isAssembly ? "ASSEMBLY" : "SIMPLE")
  })

  it("respecte une décision de fabrication explicitement fournie par l’API", async () => {
    ensemble = true
    await repoCreateVersion("piece", { indice: "B", plan_reference: "PLAN", manufacturing_mode: "SIMPLE" }, audit)
    const insert = mocks.query.mock.calls.find(([sql]) => sql.includes("INSERT INTO public.piece_technique_versions"))!
    expect(insert[1][12]).toBe("SIMPLE")
  })

  it("corrige le même indice sans réécrire son plan ni sa gamme, avec audit avant/après", async () => {
    const result = await repoUpdateVersion("piece", "version-a", { manufacturing_mode: "ASSEMBLY", assembly_supply_strategy: "MAKE_TO_ORDER", expected_updated_at: current.updated_at }, audit)
    expect(result).toMatchObject({ id: "version-a", indice: "A", manufacturing_mode: "ASSEMBLY" })
    const update = mocks.query.mock.calls.find(([sql]) => sql.includes("UPDATE public.piece_technique_versions"))!
    expect(update[0]).not.toContain("plan_reference =")
    expect(update[0]).not.toContain("indice =")
    expect(mocks.query.mock.calls.some(([sql]) => sql.includes("UPDATE public.gammes"))).toBe(false)
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ tx: expect.anything(), body: expect.objectContaining({ details: expect.objectContaining({ manufacturing_mode: { before: "SIMPLE", after: "ASSEMBLY" } }) }) }))
    expect(mocks.query).toHaveBeenLastCalledWith("COMMIT")
  })

  it.each(["APPLICABLE", "OBSOLETE"])("refuse une définition %s avant toute écriture", async (statut) => {
    current.statut = statut
    await expect(repoUpdateVersion("piece", "version-a", { manufacturing_mode: "ASSEMBLY", expected_updated_at: current.updated_at }, audit)).rejects.toMatchObject({ status: 409, code: "VERSION_LOCKED" })
    expect(mocks.query.mock.calls.some(([sql]) => sql.includes("UPDATE public.piece_technique_versions"))).toBe(false)
    expect(mocks.audit).not.toHaveBeenCalled()
    expect(mocks.query).toHaveBeenLastCalledWith("ROLLBACK")
  })

  it("refuse une révision périmée et conserve l’audit intact", async () => {
    await expect(repoUpdateVersion("piece", "version-a", { manufacturing_mode: "ASSEMBLY", expected_updated_at: "ancienne-revision" }, audit)).rejects.toMatchObject({ status: 409, code: "CONCURRENT_MODIFICATION" })
    expect(mocks.query.mock.calls.some(([sql]) => sql.includes("UPDATE public.piece_technique_versions"))).toBe(false)
    expect(mocks.audit).not.toHaveBeenCalled()
    expect(mocks.query).toHaveBeenLastCalledWith("ROLLBACK")
    expect(mocks.release).toHaveBeenCalledOnce()
  })
})
