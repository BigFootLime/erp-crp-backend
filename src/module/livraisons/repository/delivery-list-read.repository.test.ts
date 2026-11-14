import { describe, expect, it, vi } from "vitest"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"
import path from "node:path"
import ts from "typescript"
import type { Pool } from "pg"
import { createDeliveryListReadRepository } from "./delivery-list-read.repository"
import { listLivraisonsQuerySchema } from "../validators/livraisons.validators"

const zeroSummary = { total: 0, draft: 0, ready: 0, shipped: 0, delivered: 0, cancelled: 0 }

function owner(query: ReturnType<typeof vi.fn>) {
  return createDeliveryListReadRepository({ pool: { query } as unknown as Pick<Pool, "query">, toInt: value => Number(value) })
}

describe("delivery list read owner", () => {
  it("preserves count, status summary, data query order, defaults and mapped ids", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ total: 1 }] })
      .mockResolvedValueOnce({ rows: [{ total: 1, draft: 1, ready: 0, shipped: 0, delivered: 0, cancelled: 0 }] })
      .mockResolvedValueOnce({ rows: [{ id: "42", numero: "BL-42", statut: "READY", client_id: "client-1", client_company_name: "Client", commande_id: "7", commande_numero: "CMD-7", commande_numeros: ["CMD-7", "CMD-8"], affaire_id: "8", affaire_reference: "AFF-8", affaire_references: ["AFF-8"], date_creation: "2026-11-14", date_expedition: null, date_livraison: null, transporteur: null, tracking_number: null, updated_at: "2026-11-14" }] })
    await expect(owner(query).repoListLivraisons(listLivraisonsQuerySchema.parse({ page: 2, pageSize: 5, sortBy: "numero", sortDir: "asc", client_id: "client-1" }))).resolves.toMatchObject({ total: 1, summary: { total: 1, draft: 1 }, items: [{ id: "42", commande: { id: 7 }, affaire: { id: 8 }, commande_numeros: ["CMD-7", "CMD-8"] }] })
    expect(query.mock.calls).toHaveLength(3)
    expect(query.mock.calls.map(call => call[1])).toEqual([["client-1"], ["client-1"], ["client-1", 5, 5]])
    expect(query.mock.calls[2][0]).toContain("ORDER BY bl.numero ASC")
  })

  it("keeps every filter parameterized and allocation-derived order and affair scopes in all queries", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ total: 0 }] }).mockResolvedValueOnce({ rows: [zeroSummary] }).mockResolvedValueOnce({ rows: [] })
    const search = "x%' OR 1=1 --"
    await owner(query).repoListLivraisons(listLivraisonsQuerySchema.parse({ q: ` ${search} `, client_id: " client-1 ", commande_id: "73", statut: "READY", from: "2026-01-01", to: "2026-12-31", page: 3, pageSize: 7, sortBy: "updated_at", sortDir: "desc" }))
    const values = [`%${search}%`, "client-1", 73, "READY", "2026-01-01", "2026-12-31"]
    expect(query.mock.calls.map(call => call[1])).toEqual([values, values, [...values, 7, 14]])
    for (const [sql] of query.mock.calls) {
      expect(sql).not.toContain(search)
      expect(sql).toContain("scope_commande.numero ILIKE $1")
      expect(sql).toContain("scope_allocation.commande_id = $3::bigint")
    }
    expect(query.mock.calls[2][0]).toContain("scope_affaire.reference")
    expect(query.mock.calls[2][0]).toContain("ORDER BY bl.updated_at DESC")
  })

  it.each([["numero", "bl.numero"], ["statut", "bl.statut"], ["updated_at", "bl.updated_at"], ["date_creation", "bl.date_creation"]] as const)("whitelists both directions for %s", async (sortBy, column) => {
    for (const sortDir of ["asc", "desc"] as const) {
      const query = vi.fn().mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] })
      await owner(query).repoListLivraisons(listLivraisonsQuerySchema.parse({ sortBy, sortDir }))
      expect(query.mock.calls[2][0]).toContain(`ORDER BY ${column} ${sortDir.toUpperCase()}`)
    }
  })

  it("keeps zero summary fallback and propagates failures without executing later queries", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] })
    await expect(owner(query).repoListLivraisons(listLivraisonsQuerySchema.parse({}))).resolves.toEqual({ items: [], total: 0, summary: zeroSummary })
    expect(query.mock.calls.map(call => call[1])).toEqual([[], [], [50, 0]])
    const countError = new Error("count")
    const count = vi.fn().mockRejectedValueOnce(countError)
    await expect(owner(count).repoListLivraisons(listLivraisonsQuerySchema.parse({}))).rejects.toBe(countError)
    expect(count).toHaveBeenCalledTimes(1)
    const summaryError = new Error("summary")
    const summary = vi.fn().mockResolvedValueOnce({ rows: [{ total: 1 }] }).mockRejectedValueOnce(summaryError)
    await expect(owner(summary).repoListLivraisons(listLivraisonsQuerySchema.parse({}))).rejects.toBe(summaryError)
    expect(summary).toHaveBeenCalledTimes(2)
  })
})

function declaration(source: string, name: string, nested = false) {
  const file = ts.createSourceFile("x.ts", source, ts.ScriptTarget.Latest, true)
  let found: ts.Node | undefined
  const visit = (node: ts.Node) => {
    if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) && node.name?.text === name) found = node
    if (ts.isTypeAliasDeclaration(node) && node.name.text === name) found = node
    ts.forEachChild(node, visit)
  }
  visit(file)
  if (!found) throw new Error(name)
  return found.getText(file).replace(/\r\n/g, "\n").replace(nested ? /^  /gm : /$^/, "")
}

function functionContract(source: string, name: string) {
  const file = ts.createSourceFile("x.ts", source, ts.ScriptTarget.Latest, true)
  const printer = ts.createPrinter({ removeComments: false })
  let found: ts.FunctionDeclaration | ts.FunctionExpression | undefined
  const visit = (node: ts.Node) => {
    if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) && node.name?.text === name) found = node
    ts.forEachChild(node, visit)
  }
  visit(file)
  if (!found?.body) throw new Error(name)
  return {
    parameters: found.parameters.map(parameter => parameter.getText(file)),
    returnType: found.type?.getText(file),
    statements: found.body.statements.map(statement => printer.printNode(ts.EmitHint.Unspecified, statement, file)),
  }
}

describe("delivery list extraction proof", () => {
  it("moves the exact original helpers, type and list body behind an unchanged public signature", () => {
    const base = execFileSync("git", ["show", "5a2f9323f1187d9f9f676b3ff583eed89e3b4d8e:src/module/livraisons/repository/livraisons.repository.ts"], { encoding: "utf8" })
    const ownerSource = readFileSync(path.join(process.cwd(), "src/module/livraisons/repository/delivery-list-read.repository.ts"), "utf8")
    const facade = readFileSync(path.join(process.cwd(), "src/module/livraisons/repository/livraisons.repository.ts"), "utf8")
    for (const name of ["sortColumn", "sortDirection", "ListWhere", "buildListWhere"]) {
      expect(declaration(ownerSource, name)).toBe(declaration(base, name))
    }
    expect(functionContract(ownerSource, "repoListLivraisons")).toEqual(functionContract(base, "repoListLivraisons"))
    expect(facade).toMatch(/export async function repoListLivraisons\(\s*filters: ListLivraisonsQueryDTO\s*\): Promise<Paginated<BonLivraisonListItem> & \{ summary: BonLivraisonListSummary \}>/)
    expect(facade).toContain("return createDeliveryListReadRepository({ pool, toInt }).repoListLivraisons(filters)")
    expect(facade).not.toContain("function buildListWhere")
  })

  it("constructs the owner only when the public list function is invoked", async () => {
    const facade = readFileSync(path.join(process.cwd(), "src/module/livraisons/repository/livraisons.repository.ts"), "utf8")
    const ast = ts.createSourceFile("facade.ts", facade, ts.ScriptTarget.Latest, true)
    const wrapper = ast.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === "repoListLivraisons")
    expect(wrapper).toBeDefined()
    const exported: { repoListLivraisons?: (filters: Record<string, unknown>) => Promise<unknown> } = {}
    let poolReads = 0
    const query = vi.fn().mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] })
    const sandbox = { exports: exported, createDeliveryListReadRepository, toInt: (value: unknown) => Number(value) }
    Object.defineProperty(sandbox, "pool", { get: () => { poolReads++; return { query } } })
    const code = ts.transpileModule(wrapper!.getText(ast), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
    runInNewContext(code, sandbox)
    expect(poolReads).toBe(0)
    await exported.repoListLivraisons!({})
    expect(poolReads).toBe(1)
  })

  it("keeps source and emitted dependency graphs one-way, with no dynamic import", () => {
    const ownerSource = readFileSync(path.join(process.cwd(), "src/module/livraisons/repository/delivery-list-read.repository.ts"), "utf8")
    const facade = readFileSync(path.join(process.cwd(), "src/module/livraisons/repository/livraisons.repository.ts"), "utf8")
    const ownerDist = readFileSync(path.join(process.cwd(), "dist/module/livraisons/repository/delivery-list-read.repository.js"), "utf8")
    expect(ownerSource).not.toContain("livraisons.repository")
    expect(ownerSource).not.toMatch(/import\s*\(/)
    expect(facade).toContain('from "./delivery-list-read.repository"')
    expect(ownerDist).not.toContain("livraisons.repository")
    expect(ownerDist).not.toMatch(/import\s*\(/)
  })
})
