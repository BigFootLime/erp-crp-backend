import { beforeEach, describe, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({ query: vi.fn(), release: vi.fn(), connect: vi.fn(), audit: vi.fn() }))
vi.mock("../config/database", () => ({ default: { connect: mocks.connect } }))
vi.mock("../shared/codes/code-generator.service", () => ({ generatePieceTechniqueBusinessCode: vi.fn().mockResolvedValue("PLAN-C") }))
vi.mock("../module/gammes/repository/gammes.repository", () => ({ copyGammeOperationsTx: vi.fn().mockResolvedValue(2) }))
vi.mock("../module/pieces-techniques/services/document-policy.service", () => ({ freezePieceVersionRequirements: vi.fn() }))
vi.mock("../module/audit-logs/repository/audit-logs.repository", () => ({ repoInsertAuditLog: mocks.audit }))
import { repoCreateNextVersion, repoPreparePieceEdit } from "../module/pieces-techniques/repository/versions.repository"
import { preparePieceEditSchema } from "../module/pieces-techniques/validators/versions.validators"

const audit = { user_id: 42, ip: null, user_agent: null, device_type: null, os: null, browser: null, path: "/test", page_key: "pieces", client_session_id: null }
beforeEach(() => {
  vi.clearAllMocks()
  mocks.connect.mockResolvedValue({ query: mocks.query, release: mocks.release })
  mocks.query.mockImplementation(async (sql: string) => {
    if (sql.includes("FROM public.piece_technique_versions") && sql.includes("FOR SHARE")) return { rows: [{ id: "source", indice: "B", plan_reference: "PLAN", manufacturing_mode: "ASSEMBLY", assembly_supply_strategy: "MAKE_TO_ORDER" }], rowCount: 1 }
    if (sql.includes("SELECT statut::text FROM public.pieces_techniques")) return { rows: [{statut:"ACTIVE"}], rowCount:1 }
    if (sql.includes("SELECT client_id")) return { rows: [{ client_id: null, code_client: "001" }], rowCount: 1 }
    if (sql.includes("INSERT INTO public.piece_technique_versions")) return { rows: [{ id: "new", indice: "C", type_changement: "EVOLUTION" }], rowCount: 1 }
    if (sql.includes("INSERT INTO public.pieces_techniques_nomenclature")) return { rows: [], rowCount: 2 }
    return { rows: [], rowCount: 0 }
  })
})

describe("#1837 — ordinary editing", () => {
  it("reuses an existing editable dossier without requiring a client drawing change", async () => {
    const normal=mocks.query.getMockImplementation()!
    mocks.query.mockImplementation((sql:string,params?:unknown[])=>sql.includes("ORDER BY CASE statut")
      ? Promise.resolve({rows:[{id:"working",indice:"B",statut:"EN_VALIDATION"}],rowCount:1}) : normal(sql,params))
    expect(await repoPreparePieceEdit("piece",audit)).toMatchObject({version:{id:"working"},created:false})
    expect(mocks.query.mock.calls.some(([sql])=>sql.includes("INSERT INTO public.piece_technique_versions"))).toBe(false)
  })
  it("copies an applicable dossier at the same client index and distinguishes its audit purpose",async()=>{
    const normal=mocks.query.getMockImplementation()!
    const source={id:"source",indice:"B",plan_reference:"PLAN",statut:"APPLICABLE"}
    mocks.query.mockImplementation((sql:string,params?:unknown[])=>{
      if(sql.includes("ORDER BY CASE statut")||sql.includes("FOR SHARE"))return Promise.resolve({rows:[source],rowCount:1})
      if(sql.includes("INSERT INTO public.piece_technique_versions"))return Promise.resolve({rows:[{...source,id:"new",statut:"BROUILLON",change_level:"MINOR"}],rowCount:1})
      return normal(sql,params)
    })
    expect(await repoPreparePieceEdit("piece",audit)).toMatchObject({version:{id:"new",indice:"B"},created:true})
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({body:expect.objectContaining({action:"pieces-techniques.edit.prepare",details:expect.objectContaining({purpose:"EDIT",client_requirement_confirmed:false})})}))
  })
  it("refuses an archived piece and rolls the transaction back",async()=>{
    const normal=mocks.query.getMockImplementation()!
    mocks.query.mockImplementation((sql:string,params?:unknown[])=>sql.includes("SELECT statut::text FROM public.pieces_techniques")
      ? Promise.resolve({rows:[{statut:"OBSOLETE"}],rowCount:1}):normal(sql,params))
    await expect(repoPreparePieceEdit("piece",audit)).rejects.toMatchObject({status:409,code:"PIECE_ARCHIVED"})
    expect(mocks.query).toHaveBeenLastCalledWith("ROLLBACK")
    expect(mocks.release).toHaveBeenCalledOnce()
  })
  it("does not accept a client index or a mutable payload on the ordinary-edit endpoint",()=>{
    expect(preparePieceEditSchema.safeParse({body:{}}).success).toBe(true)
    expect(preparePieceEditSchema.safeParse({body:{indice:"C"}}).success).toBe(false)
  })
})

describe("#755 — clonage d'assemblage", () => {
  it("requires a confirmed client plan and meaningful reason before owning a new revision transaction", async () => {
    for (const body of [
      { indice: "C", raison_changement: "Nouveau plan C" },
      { indice: "C", client_requirement_confirmed: true as const, raison_changement: " " },
    ]) {
      await expect(repoCreateNextVersion("piece", "source", body, audit)).rejects.toMatchObject({ code: "CLIENT_REVISION_REQUIRED" });
    }
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
  })

  it("attribue la nomenclature à la nouvelle version et conserve son audit dans la transaction", async () => {
    const result = await repoCreateNextVersion("piece", "source", { indice: "C", client_requirement_confirmed: true, raison_changement: "Nouveau plan C" }, audit)
    expect(result.copied.version_nomenclature_lines).toBe(2)
    const copy = mocks.query.mock.calls.find(([sql]) => sql.includes("INSERT INTO public.pieces_techniques_nomenclature"))!
    expect(copy[1]).toEqual(["piece", "new", "source"])
    const purchases = mocks.query.mock.calls.find(([sql]) => sql.includes("INSERT INTO public.pieces_techniques_achats"))!
    expect(purchases[1]).toEqual(["piece", "new", "source", "{}", null])
    expect(purchases[0]).toContain("type_achat")
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
    await expect(repoCreateNextVersion("piece", "source", { indice: "C", client_requirement_confirmed: true, raison_changement: "Nouveau plan C" }, audit)).rejects.toMatchObject({ status: 409, message: expect.not.stringContaining("Cet indice existe déjà") })
    expect(mocks.query).toHaveBeenLastCalledWith("ROLLBACK")
    expect(mocks.query).not.toHaveBeenCalledWith("COMMIT")
    expect(mocks.audit).not.toHaveBeenCalled()
    expect(mocks.release).toHaveBeenCalledOnce()
  })
  it("keeps existing OF selections unchanged for a minor clone (#1833)", async () => {
    const normal = mocks.query.getMockImplementation()!
    mocks.query.mockImplementation((sql: string, params?: unknown[]) => {
      if (sql.includes("INSERT INTO public.piece_technique_versions"))
        return Promise.resolve({ rows: [{ id: "new", indice: "B", change_level: "MINOR", impact_interchangeabilite: false }], rowCount: 1 })
      return normal(sql, params)
    })
    await repoCreateNextVersion("piece", "source", { indice: "B", change_level: "MINOR", client_requirement_confirmed: true, raison_changement: "Plan corrigé" }, audit)
    expect(mocks.query.mock.calls.some(([sql]) => sql.includes("version_selection_mode','AUTO'"))).toBe(false)
  })
  it("does not retarget a major clone", async () => {
    const normal = mocks.query.getMockImplementation()!
    mocks.query.mockImplementation((sql: string, params?: unknown[]) => {
      if (sql.includes("INSERT INTO public.piece_technique_versions"))
        return Promise.resolve({ rows: [{ id: "new", indice: "B", change_level: "MAJOR", impact_interchangeabilite: false }], rowCount: 1 })
      return normal(sql, params)
    })
    await repoCreateNextVersion("piece", "source", { indice: "B", change_level: "MAJOR", client_requirement_confirmed: true, raison_changement: "Nouveau plan B" }, audit)
    expect(mocks.query.mock.calls.some(([sql]) => sql.includes("version_selection_mode','AUTO'"))).toBe(false)
  })
  it("keeps existing OFs and transaction ownership when reconfiguration prepares a minor draft", async () => {
    const normal = mocks.query.getMockImplementation()!
    mocks.query.mockImplementation((sql: string, params?: unknown[]) => {
      if (sql.includes("INSERT INTO public.piece_technique_versions"))
        return Promise.resolve({ rows: [{ id: "new", indice: "B", change_level: "MINOR", impact_interchangeabilite: false }], rowCount: 1 })
      return normal(sql, params)
    })
    const client = { query: mocks.query, release: mocks.release }
    await repoCreateNextVersion("piece", "source", { indice: "B", change_level: "MINOR" }, audit, client as never, { autoFollowDraftOrders: false })
    expect(mocks.query.mock.calls.some(([sql]) => /UPDATE public\.ordres_fabrication/.test(sql))).toBe(false)
    expect(mocks.query.mock.calls.some(([sql]) => /^(BEGIN|COMMIT|ROLLBACK)$/.test(sql))).toBe(false)
    expect(mocks.connect).not.toHaveBeenCalled()
    expect(mocks.release).not.toHaveBeenCalled()
    expect(mocks.audit).toHaveBeenCalled()
  })
  it("leaves rollback to the reconfiguration transaction if copying a technical version fails", async () => {
    const normal = mocks.query.getMockImplementation()!
    mocks.query.mockImplementation((sql: string, params?: unknown[]) => sql.includes("INSERT INTO public.pieces_techniques_nomenclature")
      ? Promise.reject(new Error("copy failed")) : normal(sql, params))
    const client = { query: mocks.query, release: mocks.release }
    await expect(repoCreateNextVersion("piece", "source", { indice: "C" }, audit, client as never, { autoFollowDraftOrders: false })).rejects.toThrow("copy failed")
    expect(mocks.query.mock.calls.some(([sql]) => /^(BEGIN|COMMIT|ROLLBACK)$/.test(sql))).toBe(false)
    expect(mocks.release).not.toHaveBeenCalled()
    expect(mocks.audit).not.toHaveBeenCalled()
  })
})
