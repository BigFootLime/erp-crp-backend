import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  poolConnect: vi.fn(),
  readIssuerParty: vi.fn(),
  repoGetLivraisonDetail: vi.fn(),
  repoGetDocumentName: vi.fn(),
  renderBonLivraisonDocument: vi.fn(),
}))

vi.mock("../../../config/database", () => ({
  default: {
    query: (...args: unknown[]) => mocks.poolQuery(...args),
    connect: (...args: unknown[]) => mocks.poolConnect(...args),
  },
}))
vi.mock("../../../shared/documents/issuer-identity.repository", () => ({
  readIssuerParty: (...args: unknown[]) => mocks.readIssuerParty(...args),
}))
vi.mock("../repository/livraisons.repository", () => ({
  repoGetLivraisonDetail: (...args: unknown[]) => mocks.repoGetLivraisonDetail(...args),
  repoGetDocumentName: (...args: unknown[]) => mocks.repoGetDocumentName(...args),
}))
vi.mock("./bon-livraison-document", () => ({
  renderBonLivraisonDocument: (...args: unknown[]) => mocks.renderBonLivraisonDocument(...args),
}))

import {
  svcGenerateLivraisonPdf,
  svcGetLivraisonPdfAvailability,
} from "./pdf.service"

const BL_ID = "11111111-1111-4111-8111-111111111111"
const DOC_ID = "22222222-2222-4222-8222-222222222222"
const PDF_BYTES = Buffer.from("%PDF-1.7\nsynthetic")

type TestPoolClient = {
  query: ReturnType<typeof vi.fn>
  release: ReturnType<typeof vi.fn>
}

let documentsRoot = ""

function detail(lines: unknown[] = []) {
  return {
    bon_livraison: {
      id: BL_ID,
      numero: "BL-2026-0018",
      statut: "DRAFT",
      date_creation: "2026-08-04",
      date_expedition: null,
    },
    lignes: lines,
    documents: [],
    proofs: [],
    events: [],
  }
}

function generationDb(options: {
  nextVersion?: number
  replay?: {
    document_id: string
    version: number
    generated_at: string
    file_size_bytes: number
  }
} = {}): TestPoolClient {
  const query = vi.fn(async (sqlValue: unknown) => {
    const sql = String(sqlValue)
    if (sql.includes("SELECT id::text AS id") && sql.includes("FOR UPDATE")) {
      return { rows: [{ id: BL_ID }] }
    }
    if (sql.includes("idempotency_key_hash") && sql.includes("SELECT")) {
      return {
        rows: options.replay
          ? [{ bon_livraison_id: BL_ID, ...options.replay }]
          : [],
      }
    }
    if (sql.includes("COALESCE(MAX(document.version)")) {
      return { rows: [{ version: options.nextVersion ?? 1 }] }
    }
    return { rows: [] }
  })
  return { query, release: vi.fn() }
}

async function storePdf(documentId = DOC_ID, bytes = PDF_BYTES) {
  const directory = path.join(documentsRoot, "livraisons")
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(path.join(directory, `${documentId}.pdf`), bytes)
}

beforeEach(async () => {
  vi.clearAllMocks()
  documentsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cerp-pdf-availability-"))
  process.env.CERP_DOCUMENTS_ROOT = documentsRoot
  mocks.readIssuerParty.mockResolvedValue({ company_name: "CERP" })
  mocks.repoGetLivraisonDetail.mockResolvedValue(detail())
  mocks.repoGetDocumentName.mockResolvedValue("Bon_livraison_BL-2026-0018.pdf")
  mocks.renderBonLivraisonDocument.mockResolvedValue(PDF_BYTES)
})

afterEach(async () => {
  delete process.env.CERP_DOCUMENTS_ROOT
  await fs.rm(documentsRoot, { recursive: true, force: true })
})

describe("livraison PDF availability", () => {
  it("reports an empty draft as not generated without creating a document", async () => {
    mocks.poolQuery.mockResolvedValue({
      rows: [{
        bon_livraison_id: BL_ID,
        document_id: null,
        version: null,
        generated_at: null,
        file_size_bytes: null,
      }],
    })

    await expect(svcGetLivraisonPdfAvailability(BL_ID)).resolves.toEqual({
      available: false,
      status: "NOT_GENERATED",
      document_id: null,
      version: null,
      generated_at: null,
    })
    expect(mocks.poolQuery).toHaveBeenCalledWith(
      expect.stringContaining("document.type = 'GENERATED_SIMPLE_BL_PDF'"),
      [BL_ID, null],
    )
    expect(String(mocks.poolQuery.mock.calls[0]?.[0])).not.toContain(
      "document.type = 'GENERATED_BL_PDF'",
    )
    await expect(fs.readdir(documentsRoot)).resolves.toEqual([])
  })

  it("only reports a generated archive as available when its PDF file is readable", async () => {
    await storePdf()
    mocks.poolQuery.mockResolvedValue({
      rows: [{
        bon_livraison_id: BL_ID,
        document_id: DOC_ID,
        version: 3,
        generated_at: "2026-08-04T12:00:00.000Z",
        file_size_bytes: PDF_BYTES.byteLength,
      }],
    })

    await expect(svcGetLivraisonPdfAvailability(BL_ID)).resolves.toEqual({
      available: true,
      status: "AVAILABLE",
      document_id: DOC_ID,
      version: 3,
      generated_at: "2026-08-04T12:00:00.000Z",
    })
  })

  it("surfaces a missing archived file as an integrity error, not ordinary unavailability", async () => {
    mocks.poolQuery.mockResolvedValue({
      rows: [{
        bon_livraison_id: BL_ID,
        document_id: DOC_ID,
        version: 1,
        generated_at: "2026-08-04T12:00:00.000Z",
        file_size_bytes: PDF_BYTES.byteLength,
      }],
    })

    await expect(svcGetLivraisonPdfAvailability(BL_ID)).rejects.toMatchObject({
      status: 410,
      code: "LIVRAISON_PDF_FILE_MISSING",
    })
  })
})

describe("livraison PDF generation", () => {
  it("generates a valid archived version for an empty draft", async () => {
    const db = generationDb()
    mocks.poolConnect.mockResolvedValue(db)

    const result = await svcGenerateLivraisonPdf(BL_ID, 7, "generate-empty-draft")

    expect(result).toMatchObject({ version: 1, idempotent_replay: false })
    expect(mocks.renderBonLivraisonDocument).toHaveBeenCalledWith(
      expect.objectContaining({ lignes: [], version: 1 }),
    )
    await expect(
      fs.readFile(path.join(documentsRoot, "livraisons", `${result.document_id}.pdf`)),
    ).resolves.toEqual(PDF_BYTES)
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining("FOR UPDATE"),
      [BL_ID],
    )
    expect(
      db.query.mock.calls.some(([sql]) =>
        String(sql).includes("'GENERATED_SIMPLE_BL_PDF'"),
      ),
    ).toBe(true)
  })

  it("regenerates a complete delivery as the next version", async () => {
    const db = generationDb({ nextVersion: 4 })
    mocks.poolConnect.mockResolvedValue(db)
    mocks.repoGetLivraisonDetail.mockResolvedValue(
      detail([{ id: "line-1", designation: "Pièce usinée", quantite: 2 }]),
    )

    const result = await svcGenerateLivraisonPdf(BL_ID, 7, "regenerate-complete")

    expect(result).toMatchObject({ version: 4, idempotent_replay: false })
    expect(mocks.renderBonLivraisonDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        lignes: [expect.objectContaining({ designation: "Pièce usinée" })],
        version: 4,
      }),
    )
  })

  it("replays the same actor and idempotency key without rendering another version", async () => {
    await storePdf()
    const db = generationDb({
      replay: {
        document_id: DOC_ID,
        version: 2,
        generated_at: "2026-08-04T12:00:00.000Z",
        file_size_bytes: PDF_BYTES.byteLength,
      },
    })
    mocks.poolConnect.mockResolvedValue(db)

    await expect(
      svcGenerateLivraisonPdf(BL_ID, 7, "same-generation-key"),
    ).resolves.toEqual({
      document_id: DOC_ID,
      version: 2,
      idempotent_replay: true,
    })
    expect(mocks.renderBonLivraisonDocument).not.toHaveBeenCalled()
    expect(
      db.query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO public.documents_clients")),
    ).toBe(false)
  })

  it("serializes concurrent requests so distinct keys receive distinct versions", async () => {
    let version = 0
    let locked = false
    const waiters: Array<() => void> = []

    const releaseLock = () => {
      const next = waiters.shift()
      if (next) next()
      else locked = false
    }
    const createConcurrentDb = () => {
      let ownsLock = false
      const query = vi.fn(async (sqlValue: unknown, values?: unknown[]) => {
        const sql = String(sqlValue)
        if (sql.includes("SELECT id::text AS id") && sql.includes("FOR UPDATE")) {
          if (locked) await new Promise<void>((resolve) => waiters.push(resolve))
          else locked = true
          ownsLock = true
          return { rows: [{ id: BL_ID }] }
        }
        if (sql.includes("idempotency_key_hash") && sql.includes("SELECT")) return { rows: [] }
        if (sql.includes("COALESCE(MAX(document.version)")) {
          return { rows: [{ version: version + 1 }] }
        }
        if (sql.includes("INSERT INTO public.bon_livraison_documents")) {
          version = Number(values?.[2])
        }
        if ((sql === "COMMIT" || sql === "ROLLBACK") && ownsLock) {
          ownsLock = false
          releaseLock()
        }
        return { rows: [] }
      })
      return { query, release: vi.fn() }
    }
    mocks.poolConnect.mockImplementation(async () => createConcurrentDb())

    const [first, second] = await Promise.all([
      svcGenerateLivraisonPdf(BL_ID, 7, "concurrent-key-one"),
      svcGenerateLivraisonPdf(BL_ID, 7, "concurrent-key-two"),
    ])

    expect([first.version, second.version].sort()).toEqual([1, 2])
    expect(mocks.renderBonLivraisonDocument).toHaveBeenCalledTimes(2)
  })
})
