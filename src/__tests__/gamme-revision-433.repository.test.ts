import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  poolConnect: vi.fn(),
  poolQuery: vi.fn(),
  clientQuery: vi.fn(),
  clientRelease: vi.fn(),
  insertAudit: vi.fn(),
}))

vi.mock("../config/database", () => ({
  default: {
    connect: mocks.poolConnect,
    query: mocks.poolQuery,
  },
}))

vi.mock("../module/audit-logs/repository/audit-logs.repository", () => ({
  repoInsertAuditLog: mocks.insertAudit,
}))

import { repoCreateGammeRevision } from "../module/gammes/repository/gammes.repository"

const SOURCE_ID = "11111111-1111-4111-8111-111111111111"
const VERSION_ID = "22222222-2222-4222-8222-222222222222"
const REVISION_ID = "33333333-3333-4333-8333-333333333333"
const SOURCE_OPERATION_ID = "44444444-4444-4444-8444-444444444444"
const REVISION_OPERATION_ID = "55555555-5555-4555-8555-555555555555"

const audit = {
  user_id: 42,
  ip: "127.0.0.1",
  user_agent: "vitest",
  device_type: null,
  os: null,
  browser: null,
  path: `/api/v1/gammes/${SOURCE_ID}/revisions`,
  page_key: "pieces-techniques",
  client_session_id: "test-session",
}

const source = {
  id: SOURCE_ID,
  piece_technique_version_id: VERSION_ID,
  nom: "Gamme applicable",
  code: "GAM-001",
  designation: "Gamme série",
  commentaire: null,
  statut: "APPLICABLE",
  updated_at: "2026-07-31T10:00:00.000Z",
}

const revision = {
  id: REVISION_ID,
  piece_technique_version_id: VERSION_ID,
  nom: "045-PLAN-A — Gamme 2",
  code: "GAM-001",
  designation: "Gamme série",
  commentaire: null,
  statut: "BROUILLON",
  is_current: false,
  created_at: "2026-07-31T10:01:00.000Z",
  updated_at: "2026-07-31T10:01:00.000Z",
  created_by: 42,
  updated_by: 42,
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.poolConnect.mockResolvedValue({
    query: mocks.clientQuery,
    release: mocks.clientRelease,
  })
  mocks.poolQuery.mockResolvedValue({ rows: [], rowCount: 0 })
  mocks.insertAudit.mockResolvedValue(undefined)
})

describe("#433 — duplication transactionnelle d'une gamme figée", () => {
  it("refuse une base qui ne porte pas le patch de filiation", async () => {
    mocks.clientQuery.mockImplementation((sql: string) => {
      if (String(sql).includes("information_schema.columns")) {
        return Promise.resolve({ rows: [{ present: false }], rowCount: 1 })
      }
      return Promise.resolve({ rows: [], rowCount: 0 })
    })

    await expect(
      repoCreateGammeRevision(SOURCE_ID, {}, audit, "revision-key-433"),
    ).rejects.toMatchObject({
      status: 503,
      code: "GAMME_REVISION_SCHEMA_UPGRADE_REQUIRED",
    })

    expect(mocks.clientQuery).toHaveBeenCalledWith("BEGIN")
    expect(mocks.clientQuery).toHaveBeenCalledWith("ROLLBACK")
    expect(mocks.clientRelease).toHaveBeenCalledTimes(1)
  })

  it("refuse de réviser un brouillon pour ne pas contourner son parcours d'édition", async () => {
    mocks.clientQuery.mockImplementation((sql: string) => {
      const text = String(sql)
      if (text.includes("information_schema.columns")) {
        return Promise.resolve({ rows: [{ present: true }], rowCount: 1 })
      }
      if (text.includes("FROM public.gammes WHERE id = $1 FOR UPDATE")) {
        return Promise.resolve({ rows: [{ ...source, statut: "BROUILLON" }], rowCount: 1 })
      }
      return Promise.resolve({ rows: [], rowCount: 0 })
    })

    await expect(
      repoCreateGammeRevision(SOURCE_ID, {}, audit, "revision-key-433"),
    ).rejects.toMatchObject({
      status: 409,
      code: "GAMME_REVISION_SOURCE_NOT_FROZEN",
    })

    expect(
      mocks.clientQuery.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO public.gammes")),
    ).toBe(false)
  })

  it("copie l'entête, les opérations et leurs finitions avant un unique COMMIT", async () => {
    mocks.clientQuery.mockImplementation((sql: string, params?: unknown[]) => {
      const text = String(sql)
      if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") {
        return Promise.resolve({ rows: [], rowCount: 0 })
      }
      if (text.includes("information_schema.columns") && params?.[0] === "gammes") {
        return Promise.resolve({ rows: [{ present: true }], rowCount: 1 })
      }
      if (text.includes("FROM public.gammes WHERE id = $1 FOR UPDATE")) {
        return Promise.resolve({ rows: [source], rowCount: 1 })
      }
      if (text.includes("WHERE source_gamme_id = $1 AND revision_idempotency_key = $2")) {
        return Promise.resolve({ rows: [], rowCount: 0 })
      }
      if (text.includes("FROM public.piece_technique_versions v")) {
        return Promise.resolve({
          rows: [{ code_piece: "045-PLAN", designation: "Pièce", indice: "A", existing: "1" }],
          rowCount: 1,
        })
      }
      if (text.includes("INSERT INTO public.gammes")) {
        return Promise.resolve({ rows: [revision], rowCount: 1 })
      }
      if (
        text.includes("information_schema.columns") &&
        params?.[0] === "pieces_techniques_operations"
      ) {
        return Promise.resolve({
          rows: [
            { column_name: "ordre" },
            { column_name: "phase" },
            { column_name: "designation" },
            { column_name: "type_operation" },
          ],
          rowCount: 4,
        })
      }
      if (text.includes("WITH copied AS")) {
        return Promise.resolve({
          rows: [{ old_id: SOURCE_OPERATION_ID, new_id: REVISION_OPERATION_ID }],
          rowCount: 1,
        })
      }
      if (text.includes("to_regclass('public.gamme_operation_finitions')")) {
        return Promise.resolve({ rows: [{ present: true }], rowCount: 1 })
      }
      if (
        text.includes("information_schema.columns") &&
        params?.[0] === "gamme_operation_finitions"
      ) {
        return Promise.resolve({
          rows: [
            { column_name: "piece_technique_version_id" },
            { column_name: "finish_revision_id" },
            { column_name: "spec_canonical" },
            { column_name: "spec_fingerprint" },
            { column_name: "generated_designation" },
            { column_name: "generated_comment" },
          ],
          rowCount: 6,
        })
      }
      if (text.includes("INSERT INTO public.gamme_operation_finitions")) {
        return Promise.resolve({ rows: [], rowCount: 1 })
      }
      return Promise.resolve({ rows: [], rowCount: 0 })
    })

    const result = await repoCreateGammeRevision(
      SOURCE_ID,
      { expected_updated_at: source.updated_at },
      audit,
      "revision-key-433",
    )

    expect(result).toEqual({ gamme: revision, operations_copied: 1, replayed: false })
    const statements = mocks.clientQuery.mock.calls.map(([sql]) => String(sql))
    expect(statements.some((sql) => sql.includes("INSERT INTO public.gammes"))).toBe(true)
    expect(statements.some((sql) => sql.includes("WITH copied AS"))).toBe(true)
    expect(
      statements.some((sql) => sql.includes("INSERT INTO public.gamme_operation_finitions")),
    ).toBe(true)
    expect(statements.filter((sql) => sql === "COMMIT")).toHaveLength(1)
    expect(statements.some((sql) => /^UPDATE public\.gammes/m.test(sql))).toBe(false)
    expect(mocks.insertAudit).toHaveBeenCalledTimes(1)
  })

  it("rejoue la même clé sans créer une seconde gamme", async () => {
    mocks.clientQuery.mockImplementation((sql: string) => {
      const text = String(sql)
      if (text.includes("information_schema.columns")) {
        return Promise.resolve({ rows: [{ present: true }], rowCount: 1 })
      }
      if (text.includes("FROM public.gammes WHERE id = $1 FOR UPDATE")) {
        return Promise.resolve({ rows: [source], rowCount: 1 })
      }
      if (text.includes("WHERE source_gamme_id = $1 AND revision_idempotency_key = $2")) {
        return Promise.resolve({ rows: [revision], rowCount: 1 })
      }
      if (text.includes("count(*)::text AS total")) {
        return Promise.resolve({ rows: [{ total: "3" }], rowCount: 1 })
      }
      return Promise.resolve({ rows: [], rowCount: 0 })
    })

    const result = await repoCreateGammeRevision(
      SOURCE_ID,
      {},
      audit,
      "revision-key-433",
    )

    expect(result).toEqual({ gamme: revision, operations_copied: 3, replayed: true })
    expect(
      mocks.clientQuery.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO public.gammes")),
    ).toBe(false)
    expect(mocks.clientQuery).toHaveBeenCalledWith("COMMIT")
  })
})
