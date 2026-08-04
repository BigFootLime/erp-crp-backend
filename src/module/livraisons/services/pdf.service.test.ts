import crypto from "node:crypto"
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
  loggerError: vi.fn(),
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
vi.mock("../../../utils/logger", () => ({
  default: {
    error: (...args: unknown[]) => mocks.loggerError(...args),
  },
}))

import {
  svcGenerateLivraisonPdf,
  svcGetLivraisonPdfAvailability,
  svcReadLivraisonPdf,
} from "./pdf.service"

const BL_ID = "11111111-1111-4111-8111-111111111111"
const DOC_ID = "22222222-2222-4222-8222-222222222222"
const PDF_BYTES = Buffer.from("%PDF-1.7\nsynthetic")
const PDF_CHECKSUM = crypto.createHash("sha256").update(PDF_BYTES).digest("hex")

type TestPoolClient = {
  query: ReturnType<typeof vi.fn>
  release: ReturnType<typeof vi.fn>
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
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
  statut?: "DRAFT" | "CANCELLED"
  replay?: {
    document_id: string
    version: number
    generated_at: string
    file_size_bytes: number
    checksum_sha256: string
  }
} = {}): TestPoolClient {
  const query = vi.fn(async (sqlValue: unknown) => {
    const sql = String(sqlValue)
    if (sql.includes("SELECT id::text AS id") && sql.includes("FOR UPDATE")) {
      return { rows: [{ id: BL_ID, statut: options.statut ?? "DRAFT" }] }
    }
    if (sql.includes("idempotency_key_hash") && sql.includes("SELECT")) {
      return {
        rows: options.replay
          ? [{
              bon_livraison_id: BL_ID,
              event_document_id: options.replay.document_id,
              event_version: options.replay.version,
              event_checksum_sha256: options.replay.checksum_sha256,
              ...options.replay,
            }]
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

function uncertainCommitDatabase(options: {
  durable: boolean
  reconciliationError?: Error
  reconciledDocumentId?: string
  reconciledVersion?: number
  reconciledEventChecksum?: string
  reconciledDocumentChecksum?: string
  beforeReconciliationLookup?: () => Promise<void>
  afterReconciliationCommit?: () => Promise<void>
}) {
  let documentId: string | null = null
  let persisted: {
    document_id: string
    version: number
    generated_at: string
    file_size_bytes: number
    checksum_sha256: string
  } | null = null

  const primaryQuery = vi.fn(async (sqlValue: unknown, values?: unknown[]) => {
    const sql = String(sqlValue)
    if (sql.includes("SELECT id::text AS id") && sql.includes("statut") && sql.includes("FOR UPDATE")) {
      return { rows: [{ id: BL_ID, statut: "DRAFT" }] }
    }
    if (sql.includes("idempotency_key_hash") && sql.includes("SELECT")) return { rows: [] }
    if (sql.includes("COALESCE(MAX(document.version)")) return { rows: [{ version: 1 }] }
    if (sql.includes("INSERT INTO public.bon_livraison_documents")) {
      documentId = String(values?.[1])
      persisted = {
        document_id: documentId,
        version: Number(values?.[2]),
        generated_at: "2026-08-04T12:00:00.000Z",
        file_size_bytes: Number(values?.[5]),
        checksum_sha256: String(values?.[4]),
      }
    }
    if (sql === "COMMIT") {
      if (!options.durable) persisted = null
      throw Object.assign(new Error("commit acknowledgement lost"), { code: "ECONNRESET" })
    }
    return { rows: [] }
  })
  const reconciliationQuery = vi.fn(async (sqlValue: unknown) => {
    const sql = String(sqlValue)
    if (sql === "COMMIT") {
      await options.afterReconciliationCommit?.()
      return { rows: [] }
    }
    if (sql.includes("FROM public.bon_livraison") && sql.includes("FOR UPDATE")) {
      return { rows: [{ id: BL_ID }] }
    }
    if (sql.includes("idempotency_key_hash") && sql.includes("SELECT")) {
      await options.beforeReconciliationLookup?.()
      if (options.reconciliationError) throw options.reconciliationError
      return {
        rows: persisted
          ? [{
              bon_livraison_id: BL_ID,
              event_document_id: persisted.document_id,
              event_version: persisted.version,
              event_checksum_sha256:
                options.reconciledEventChecksum ?? persisted.checksum_sha256,
              ...persisted,
              document_id: options.reconciledDocumentId ?? persisted.document_id,
              version: options.reconciledVersion ?? persisted.version,
              checksum_sha256:
                options.reconciledDocumentChecksum ?? persisted.checksum_sha256,
            }]
          : [],
      }
    }
    return { rows: [] }
  })
  const primary: TestPoolClient = { query: primaryQuery, release: vi.fn() }
  const reconciliation: TestPoolClient = { query: reconciliationQuery, release: vi.fn() }

  return {
    primary,
    reconciliation,
    getDocumentId: () => documentId,
    getPersisted: () => persisted,
  }
}

async function storePdf(documentId = DOC_ID, bytes = PDF_BYTES) {
  const directory = path.join(documentsRoot, "livraisons")
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(path.join(directory, `${documentId}.pdf`), bytes)
}

function lifecycleDatabase() {
  let statut: "DRAFT" | "CANCELLED" = "DRAFT"
  let version = 0
  let lockOwner: symbol | null = null
  const waiters: Array<() => void> = []
  const lockWaiterQueued = deferred()

  const releaseLock = (owner: symbol) => {
    if (lockOwner !== owner) return
    const next = waiters.shift()
    if (next) next()
    else lockOwner = null
  }

  const connect = (): TestPoolClient => {
    const owner = Symbol("delivery-transaction")
    let ownsLock = false
    const query = vi.fn(async (sqlValue: unknown, values?: unknown[]) => {
      const sql = String(sqlValue)
      if (sql.includes("SELECT id::text AS id") && sql.includes("FOR UPDATE")) {
        if (lockOwner !== null) {
          lockWaiterQueued.resolve()
          await new Promise<void>((done) => waiters.push(done))
        }
        lockOwner = owner
        ownsLock = true
        return { rows: [{ id: BL_ID, statut }] }
      }
      if (sql.includes("TEST_CANCEL_DELIVERY")) {
        statut = "CANCELLED"
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
        releaseLock(owner)
      }
      return { rows: [] }
    })
    return { query, release: vi.fn() }
  }

  return {
    connect,
    getStatut: () => statut,
    waitForBlockedTransaction: lockWaiterQueued.promise,
  }
}

async function cancelDeliveryWithRowLock(
  afterLock?: () => Promise<void> | void,
): Promise<void> {
  const db = await mocks.poolConnect()
  try {
    await db.query("BEGIN")
    await db.query(
      `SELECT id::text AS id, statut FROM public.bon_livraison WHERE id = $1::uuid FOR UPDATE`,
      [BL_ID],
    )
    await db.query(`UPDATE public.bon_livraison SET statut = 'CANCELLED' /* TEST_CANCEL_DELIVERY */`)
    await afterLock?.()
    await db.query("COMMIT")
  } catch (error) {
    await db.query("ROLLBACK")
    throw error
  } finally {
    db.release()
  }
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
        checksum_sha256: null,
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
        checksum_sha256: PDF_CHECKSUM,
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

  it("returns the exact validated bytes for a version-specific read", async () => {
    await storePdf()
    mocks.poolQuery.mockResolvedValue({
      rows: [{
        bon_livraison_id: BL_ID,
        document_id: DOC_ID,
        version: 3,
        generated_at: "2026-08-04T12:00:00.000Z",
        file_size_bytes: PDF_BYTES.byteLength,
        checksum_sha256: PDF_CHECKSUM,
      }],
    })

    const result = await svcReadLivraisonPdf(BL_ID, 3)

    expect(result).toMatchObject({
      available: true,
      status: "AVAILABLE",
      document_id: DOC_ID,
      version: 3,
      generated_at: "2026-08-04T12:00:00.000Z",
    })
    expect(result.bytes).toEqual(PDF_BYTES)
    expect(mocks.poolQuery).toHaveBeenCalledWith(
      expect.stringContaining("latest.checksum_sha256"),
      [BL_ID, 3],
    )
  })

  it("surfaces a missing archived file as an integrity error, not ordinary unavailability", async () => {
    mocks.poolQuery.mockResolvedValue({
      rows: [{
        bon_livraison_id: BL_ID,
        document_id: DOC_ID,
        version: 1,
        generated_at: "2026-08-04T12:00:00.000Z",
        file_size_bytes: PDF_BYTES.byteLength,
        checksum_sha256: PDF_CHECKSUM,
      }],
    })

    await expect(svcGetLivraisonPdfAvailability(BL_ID)).rejects.toMatchObject({
      status: 410,
      code: "LIVRAISON_PDF_FILE_MISSING",
    })
  })

  it("rejects a version-specific archive whose bytes changed without changing size or signature", async () => {
    const corruptedBytes = Buffer.from(PDF_BYTES)
    corruptedBytes[corruptedBytes.byteLength - 1] ^= 1
    expect(corruptedBytes.byteLength).toBe(PDF_BYTES.byteLength)
    expect(corruptedBytes.subarray(0, 5).toString("ascii")).toBe("%PDF-")
    await storePdf(DOC_ID, corruptedBytes)
    mocks.poolQuery.mockResolvedValue({
      rows: [{
        bon_livraison_id: BL_ID,
        document_id: DOC_ID,
        version: 3,
        generated_at: "2026-08-04T12:00:00.000Z",
        file_size_bytes: PDF_BYTES.byteLength,
        checksum_sha256: PDF_CHECKSUM,
      }],
    })

    await expect(svcGetLivraisonPdfAvailability(BL_ID, 3)).rejects.toMatchObject({
      status: 500,
      code: "LIVRAISON_PDF_INTEGRITY_ERROR",
    })
    expect(mocks.poolQuery).toHaveBeenCalledWith(
      expect.stringContaining("latest.checksum_sha256"),
      [BL_ID, 3],
    )
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
      expect.stringContaining("id::text AS id, statut"),
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
        checksum_sha256: PDF_CHECKSUM,
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

  it("keeps a durable PDF when COMMIT succeeds but its acknowledgement is lost", async () => {
    const scenario = uncertainCommitDatabase({ durable: true })
    mocks.poolConnect
      .mockResolvedValueOnce(scenario.primary)
      .mockResolvedValueOnce(scenario.reconciliation)

    const result = await svcGenerateLivraisonPdf(BL_ID, 7, "durable-commit-reconcile")

    expect(result).toMatchObject({ version: 1, idempotent_replay: false })
    expect(result.document_id).toBe(scenario.getDocumentId())
    await expect(
      fs.readFile(path.join(documentsRoot, "livraisons", `${result.document_id}.pdf`)),
    ).resolves.toEqual(PDF_BYTES)
    expect(scenario.primary.query).not.toHaveBeenCalledWith("ROLLBACK")
    expect(scenario.primary.release).toHaveBeenCalledWith(expect.any(Error))
    expect(scenario.reconciliation.query).toHaveBeenCalledWith(
      expect.stringContaining("FOR UPDATE"),
      [BL_ID],
    )
    const reconciliationStatements = scenario.reconciliation.query.mock.calls.map(([sql]) =>
      String(sql),
    )
    expect(reconciliationStatements[0]).toBe("BEGIN")
    expect(reconciliationStatements.findIndex((sql) => sql.includes("FOR UPDATE"))).toBe(1)
    expect(
      reconciliationStatements.findIndex((sql) => sql.includes("idempotency_key_hash")),
    ).toBe(2)
    expect(reconciliationStatements[3]).toBe("COMMIT")
    expect(scenario.reconciliation.release).toHaveBeenCalledWith()

    const persisted = scenario.getPersisted()
    expect(persisted).not.toBeNull()
    const retryDb = generationDb({ replay: persisted ?? undefined })
    mocks.poolConnect.mockResolvedValueOnce(retryDb)

    await expect(
      svcGenerateLivraisonPdf(BL_ID, 7, "durable-commit-reconcile"),
    ).resolves.toEqual({
      document_id: result.document_id,
      version: 1,
      idempotent_replay: true,
    })
    expect(mocks.renderBonLivraisonDocument).toHaveBeenCalledTimes(1)
  })

  it("holds the reconciliation transaction across the lock barrier and proof lookup", async () => {
    const lookupStarted = deferred()
    const allowLookup = deferred()
    const scenario = uncertainCommitDatabase({
      durable: true,
      beforeReconciliationLookup: async () => {
        lookupStarted.resolve()
        await allowLookup.promise
      },
    })
    mocks.poolConnect
      .mockResolvedValueOnce(scenario.primary)
      .mockResolvedValueOnce(scenario.reconciliation)

    const generation = svcGenerateLivraisonPdf(BL_ID, 7, "atomic-commit-reconcile")
    await lookupStarted.promise

    const pendingStatements = scenario.reconciliation.query.mock.calls.map(([sql]) => String(sql))
    expect(pendingStatements[0]).toBe("BEGIN")
    expect(pendingStatements[1]).toContain("FOR UPDATE")
    expect(pendingStatements[2]).toContain("idempotency_key_hash")
    expect(pendingStatements).not.toContain("COMMIT")
    expect(scenario.reconciliation.release).not.toHaveBeenCalled()

    allowLookup.resolve()
    await expect(generation).resolves.toMatchObject({ version: 1, idempotent_replay: false })
    expect(scenario.reconciliation.query).toHaveBeenLastCalledWith("COMMIT")
    expect(scenario.reconciliation.release).toHaveBeenCalledWith()
  })

  it("cleans the file when a failed COMMIT is proven non-durable", async () => {
    const scenario = uncertainCommitDatabase({ durable: false })
    mocks.poolConnect
      .mockResolvedValueOnce(scenario.primary)
      .mockResolvedValueOnce(scenario.reconciliation)

    await expect(
      svcGenerateLivraisonPdf(BL_ID, 7, "non-durable-commit"),
    ).rejects.toMatchObject({ code: "ECONNRESET" })

    const documentId = scenario.getDocumentId()
    expect(documentId).not.toBeNull()
    await expect(
      fs.access(path.join(documentsRoot, "livraisons", `${documentId}.pdf`)),
    ).rejects.toMatchObject({ code: "ENOENT" })
    expect(scenario.getPersisted()).toBeNull()
    expect(scenario.primary.query).not.toHaveBeenCalledWith("ROLLBACK")
    expect(mocks.loggerError).not.toHaveBeenCalled()
  })

  it("preserves a potentially referenced file when commit reconciliation fails", async () => {
    const scenario = uncertainCommitDatabase({
      durable: true,
      reconciliationError: new Error("reconciliation database unavailable"),
    })
    mocks.poolConnect
      .mockResolvedValueOnce(scenario.primary)
      .mockResolvedValueOnce(scenario.reconciliation)

    await expect(
      svcGenerateLivraisonPdf(BL_ID, 7, "uncertain-commit-lookup"),
    ).rejects.toMatchObject({
      status: 503,
      code: "LIVRAISON_PDF_COMMIT_UNCERTAIN",
    })

    const documentId = scenario.getDocumentId()
    expect(documentId).not.toBeNull()
    await expect(
      fs.readFile(path.join(documentsRoot, "livraisons", `${documentId}.pdf`)),
    ).resolves.toEqual(PDF_BYTES)
    expect(scenario.getPersisted()).not.toBeNull()
    expect(scenario.primary.query).not.toHaveBeenCalledWith("ROLLBACK")
    expect(mocks.loggerError).toHaveBeenCalledWith(
      "livraison_pdf_commit_uncertain",
      expect.objectContaining({ document_id: documentId, version: 1 }),
    )
  })

  it("preserves the file and fails closed when reconciliation resolves another document identity", async () => {
    const scenario = uncertainCommitDatabase({
      durable: true,
      reconciledDocumentId: "99999999-9999-4999-8999-999999999999",
    })
    mocks.poolConnect
      .mockResolvedValueOnce(scenario.primary)
      .mockResolvedValueOnce(scenario.reconciliation)

    await expect(
      svcGenerateLivraisonPdf(BL_ID, 7, "uncertain-commit-identity"),
    ).rejects.toMatchObject({
      status: 503,
      code: "LIVRAISON_PDF_COMMIT_UNCERTAIN",
    })

    const documentId = scenario.getDocumentId()
    expect(documentId).not.toBeNull()
    await expect(
      fs.readFile(path.join(documentsRoot, "livraisons", `${documentId}.pdf`)),
    ).resolves.toEqual(PDF_BYTES)
    expect(scenario.getPersisted()).not.toBeNull()
    expect(mocks.loggerError).toHaveBeenCalledWith(
      "livraison_pdf_commit_uncertain",
      expect.objectContaining({ document_id: documentId, version: 1 }),
    )
    expect(scenario.reconciliation.query).toHaveBeenCalledWith("ROLLBACK")
    expect(scenario.reconciliation.release).toHaveBeenCalledWith(expect.any(Error))
  })

  it("preserves the file and fails closed when reconciliation resolves another version", async () => {
    const scenario = uncertainCommitDatabase({ durable: true, reconciledVersion: 2 })
    mocks.poolConnect
      .mockResolvedValueOnce(scenario.primary)
      .mockResolvedValueOnce(scenario.reconciliation)

    await expect(
      svcGenerateLivraisonPdf(BL_ID, 7, "uncertain-commit-version"),
    ).rejects.toMatchObject({
      status: 503,
      code: "LIVRAISON_PDF_COMMIT_UNCERTAIN",
    })

    const documentId = scenario.getDocumentId()
    expect(documentId).not.toBeNull()
    await expect(
      fs.readFile(path.join(documentsRoot, "livraisons", `${documentId}.pdf`)),
    ).resolves.toEqual(PDF_BYTES)
    expect(scenario.reconciliation.query).toHaveBeenCalledWith("ROLLBACK")
    expect(scenario.reconciliation.release).toHaveBeenCalledWith(expect.any(Error))
  })

  it.each([
    { label: "event checksum", overrides: { reconciledEventChecksum: "a".repeat(64) } },
    { label: "document checksum", overrides: { reconciledDocumentChecksum: "b".repeat(64) } },
    {
      label: "pending checksum",
      overrides: {
        reconciledEventChecksum: "c".repeat(64),
        reconciledDocumentChecksum: "c".repeat(64),
      },
    },
  ])("preserves the file when the $label does not match the three-way proof", async ({ label, overrides }) => {
    const scenario = uncertainCommitDatabase({ durable: true, ...overrides })
    mocks.poolConnect
      .mockResolvedValueOnce(scenario.primary)
      .mockResolvedValueOnce(scenario.reconciliation)

    await expect(
      svcGenerateLivraisonPdf(BL_ID, 7, `uncertain-${label.replace(" ", "-")}`),
    ).rejects.toMatchObject({
      status: 503,
      code: "LIVRAISON_PDF_COMMIT_UNCERTAIN",
    })

    const documentId = scenario.getDocumentId()
    expect(documentId).not.toBeNull()
    await expect(
      fs.readFile(path.join(documentsRoot, "livraisons", `${documentId}.pdf`)),
    ).resolves.toEqual(PDF_BYTES)
    expect(scenario.reconciliation.query).toHaveBeenCalledWith("ROLLBACK")
    expect(scenario.reconciliation.release).toHaveBeenCalledWith(expect.any(Error))
    expect(mocks.loggerError).toHaveBeenCalledWith(
      "livraison_pdf_commit_uncertain",
      expect.objectContaining({
        document_id: documentId,
        version: 1,
        expected_checksum_sha256: PDF_CHECKSUM,
      }),
    )
  })

  it("validates durable bytes against the pre-commit checksum and preserves corruption", async () => {
    const corruptedBytes = Buffer.from(PDF_BYTES)
    corruptedBytes[corruptedBytes.byteLength - 1] ^= 1
    let scenario!: ReturnType<typeof uncertainCommitDatabase>
    scenario = uncertainCommitDatabase({
      durable: true,
      afterReconciliationCommit: async () => {
        const documentId = scenario.getDocumentId()
        if (!documentId) throw new Error("test document id unavailable")
        await fs.writeFile(
          path.join(documentsRoot, "livraisons", `${documentId}.pdf`),
          corruptedBytes,
        )
      },
    })
    mocks.poolConnect
      .mockResolvedValueOnce(scenario.primary)
      .mockResolvedValueOnce(scenario.reconciliation)

    await expect(
      svcGenerateLivraisonPdf(BL_ID, 7, "durable-file-corruption"),
    ).rejects.toMatchObject({
      status: 500,
      code: "LIVRAISON_PDF_INTEGRITY_ERROR",
    })

    const documentId = scenario.getDocumentId()
    expect(documentId).not.toBeNull()
    await expect(
      fs.readFile(path.join(documentsRoot, "livraisons", `${documentId}.pdf`)),
    ).resolves.toEqual(corruptedBytes)
    expect(scenario.reconciliation.query).toHaveBeenLastCalledWith("COMMIT")
    expect(scenario.reconciliation.query).not.toHaveBeenCalledWith("ROLLBACK")
    expect(mocks.loggerError).not.toHaveBeenCalled()
  })

  it("preserves the file when no fresh connection can reconcile the commit", async () => {
    const scenario = uncertainCommitDatabase({ durable: true })
    mocks.poolConnect
      .mockResolvedValueOnce(scenario.primary)
      .mockRejectedValueOnce(new Error("reconciliation pool unavailable"))

    await expect(
      svcGenerateLivraisonPdf(BL_ID, 7, "uncertain-commit-connect"),
    ).rejects.toMatchObject({
      status: 503,
      code: "LIVRAISON_PDF_COMMIT_UNCERTAIN",
    })

    const documentId = scenario.getDocumentId()
    expect(documentId).not.toBeNull()
    await expect(
      fs.readFile(path.join(documentsRoot, "livraisons", `${documentId}.pdf`)),
    ).resolves.toEqual(PDF_BYTES)
    expect(scenario.getPersisted()).not.toBeNull()
    expect(scenario.primary.query).not.toHaveBeenCalledWith("ROLLBACK")
    expect(mocks.loggerError).toHaveBeenCalledWith(
      "livraison_pdf_commit_uncertain",
      expect.objectContaining({
        document_id: documentId,
        version: 1,
        reconciliation_error: "reconciliation pool unavailable",
      }),
    )
  })

  it("rejects a same-size checksum corruption during idempotent replay", async () => {
    const corruptedBytes = Buffer.from(PDF_BYTES)
    corruptedBytes[corruptedBytes.byteLength - 1] ^= 1
    await storePdf(DOC_ID, corruptedBytes)
    const db = generationDb({
      replay: {
        document_id: DOC_ID,
        version: 2,
        generated_at: "2026-08-04T12:00:00.000Z",
        file_size_bytes: PDF_BYTES.byteLength,
        checksum_sha256: PDF_CHECKSUM,
      },
    })
    mocks.poolConnect.mockResolvedValue(db)

    await expect(
      svcGenerateLivraisonPdf(BL_ID, 7, "corrupted-replay-key"),
    ).rejects.toMatchObject({
      status: 500,
      code: "LIVRAISON_PDF_INTEGRITY_ERROR",
    })
    expect(mocks.renderBonLivraisonDocument).not.toHaveBeenCalled()
    expect(db.query).toHaveBeenCalledWith("ROLLBACK")
    expect(
      db.query.mock.calls.some(([sql]) =>
        String(sql).includes("document.checksum_sha256"),
      ),
    ).toBe(true)
  })

  it("rejects generation and creator replay after cancellation before rendering", async () => {
    await storePdf()
    const db = generationDb({
      statut: "CANCELLED",
      replay: {
        document_id: DOC_ID,
        version: 2,
        generated_at: "2026-08-04T12:00:00.000Z",
        file_size_bytes: PDF_BYTES.byteLength,
        checksum_sha256: PDF_CHECKSUM,
      },
    })
    mocks.poolConnect.mockResolvedValue(db)

    await expect(
      svcGenerateLivraisonPdf(BL_ID, 7, "cancelled-replay-key"),
    ).rejects.toMatchObject({
      status: 409,
      code: "LIVRAISON_CANCELLED_PDF_FORBIDDEN",
    })
    expect(mocks.renderBonLivraisonDocument).not.toHaveBeenCalled()
    expect(
      db.query.mock.calls.some(([sql]) => String(sql).includes("idempotency_key_hash")),
    ).toBe(false)
    expect(db.query).toHaveBeenCalledWith("ROLLBACK")
  })

  it("lets cancellation win the row lock and blocks the waiting generation before render", async () => {
    const lifecycle = lifecycleDatabase()
    mocks.poolConnect.mockImplementation(async () => lifecycle.connect())
    const cancellationLocked = deferred()
    const allowCancellationCommit = deferred()

    const cancellation = cancelDeliveryWithRowLock(async () => {
      cancellationLocked.resolve()
      await allowCancellationCommit.promise
    })
    await cancellationLocked.promise
    const generation = svcGenerateLivraisonPdf(BL_ID, 7, "cancel-wins-generation")

    await lifecycle.waitForBlockedTransaction
    expect(mocks.renderBonLivraisonDocument).not.toHaveBeenCalled()
    allowCancellationCommit.resolve()
    await cancellation
    await expect(generation).rejects.toMatchObject({
      status: 409,
      code: "LIVRAISON_CANCELLED_PDF_FORBIDDEN",
    })
    expect(lifecycle.getStatut()).toBe("CANCELLED")
    expect(mocks.renderBonLivraisonDocument).not.toHaveBeenCalled()
  })

  it("lets an already locked generation finish, then blocks every post-cancellation render", async () => {
    const lifecycle = lifecycleDatabase()
    mocks.poolConnect.mockImplementation(async () => lifecycle.connect())
    const rendering = deferred()
    const allowRender = deferred()
    mocks.renderBonLivraisonDocument.mockImplementationOnce(async () => {
      rendering.resolve()
      await allowRender.promise
      return PDF_BYTES
    })

    const generation = svcGenerateLivraisonPdf(BL_ID, 7, "generation-wins-cancel")
    await rendering.promise
    const cancellation = cancelDeliveryWithRowLock()
    await lifecycle.waitForBlockedTransaction
    expect(lifecycle.getStatut()).toBe("DRAFT")

    allowRender.resolve()
    await expect(generation).resolves.toMatchObject({ version: 1 })
    await cancellation
    expect(lifecycle.getStatut()).toBe("CANCELLED")

    await expect(
      svcGenerateLivraisonPdf(BL_ID, 7, "post-cancel-generation"),
    ).rejects.toMatchObject({
      status: 409,
      code: "LIVRAISON_CANCELLED_PDF_FORBIDDEN",
    })
    expect(mocks.renderBonLivraisonDocument).toHaveBeenCalledTimes(1)
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
          return { rows: [{ id: BL_ID, statut: "DRAFT" }] }
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
