import crypto from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const database = vi.hoisted(() => ({
  connect: vi.fn(),
  query: vi.fn(),
}))

vi.mock("../config/database", () => ({
  default: {
    connect: database.connect,
    query: database.query,
  },
}))

import { uploadDocument } from "../module/ged/services/ged.service"
import { storageKeyForSha256 } from "../module/ged/services/ged-vault.service"
import { archiveOfDocument } from "../module/production/services/of-document-archive"
import { withOfTransaction } from "../module/production/repository/of-versioning.repository"
import {
  clearRegisteredUploadDestinationsForTests,
} from "../shared/uploads/secure-upload"

const VALID_PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n")
const SHA256 = crypto.createHash("sha256").update(VALID_PDF).digest("hex")
const CLASS_ROW = {
  class_key: "PLAN_CLIENT",
  domain: "QUALITE",
  label: "Plan client",
  nature: "PLAN",
  allowed_mime_types: ["application/pdf"],
  allowed_extensions: [".pdf"],
  max_size_bytes: String(1024 * 1024),
  approvals_required: 0,
  retention_months: null,
  hold_on_publish: false,
  is_active: true,
}

type Deferred = Readonly<{ promise: Promise<void>; resolve: () => void }>

function deferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

type ScenarioKind = "cleanup-first" | "of-first" | "both-rollback" | "ack-b-first"
type ClientRole = "a" | "b" | "of" | "cleanup-a" | "cleanup-b"
type FakeClient = {
  role: ClientRole
  hasReference: boolean
  query: (sql: string, params?: readonly unknown[]) => Promise<{ rows: any[] }>
  release: ReturnType<typeof vi.fn>
}

function rolesFor(kind: ScenarioKind): ClientRole[] {
  if (kind === "cleanup-first") return ["a", "cleanup-a", "b"]
  if (kind === "of-first") return ["a", "of", "cleanup-a"]
  if (kind === "ack-b-first") return ["a", "b", "cleanup-a"]
  return ["a", "b", "cleanup-a", "cleanup-b"]
}

function installDatabaseScenario(kind: ScenarioKind, durablePath: string) {
  const allowAFailure = deferred()
  const aAtFailure = deferred()
  const allowBFailure = deferred()
  const bAtFailure = deferred()
  const allowCleanupReference = deferred()
  const cleanupAtReference = deferred()
  const allowOfCommit = deferred()
  const ofAtCommit = deferred()
  const allowACommitAckLoss = deferred()
  const aAtCommit = deferred()
  const allowBCommit = deferred()
  const bAtCommit = deferred()
  const queued = new Map<ClientRole, Deferred>([
    ["b", deferred()],
    ["of", deferred()],
    ["cleanup-a", deferred()],
    ["cleanup-b", deferred()],
  ])
  const roleOrder = rolesFor(kind)
  const waiters: Array<{ client: FakeClient; resume: () => void }> = []
  const clients: FakeClient[] = []
  const aError = new Error("A metadata mutation failed")
  const bError = new Error("B metadata mutation failed")
  const commitAckError = new Error("A COMMIT acknowledgement was lost")
  let owner: FakeClient | null = null
  let committedReference = false
  let referenceQueries = 0
  let cleanupDeletedBeforeRelease = false

  const acquireBlobLock = async (client: FakeClient) => {
    if (owner === null) {
      owner = client
      return
    }
    await new Promise<void>((resume) => {
      waiters.push({ client, resume })
      queued.get(client.role)?.resolve()
    })
  }

  const releaseBlobLock = (client: FakeClient) => {
    if (owner !== client) return
    const next = waiters.shift()
    owner = next?.client ?? null
    next?.resume()
  }

  database.query.mockImplementation(async (sql: string) => {
    if (sql.includes("FROM public.ged_document_classes")) return { rows: [CLASS_ROW] }
    if (sql.includes("version_sha256") && kind === "ack-b-first") {
      return { rows: [{ version_sha256: null, blob_present: false }] }
    }
    // Successful uploadDocument calls reread after COMMIT. A null detail is
    // sufficient here because the concurrency assertions concern durability.
    if (sql.includes("FROM public.ged_documents d")) return { rows: [] }
    throw new Error(`Unexpected pool query: ${sql}`)
  })

  database.connect.mockImplementation(async () => {
    const role = roleOrder[clients.length]
    if (!role) throw new Error(`Unexpected database connection ${clients.length + 1}`)

    const client = {} as FakeClient
    client.role = role
    client.hasReference = false
    client.release = vi.fn((destroy?: boolean) => {
      if (destroy) releaseBlobLock(client)
    })
    client.query = async (sql: string, params: readonly unknown[] = []) => {
      if (sql === "BEGIN") return { rows: [] }

      if (sql.includes("pg_catalog.hashtextextended")) {
        expect(params[0]).toBe(`ged_blob_sha256:${SHA256}`)
        await acquireBlobLock(client)
        return { rows: [] }
      }

      if (sql === "COMMIT") {
        if (role === "a" && kind === "ack-b-first") {
          aAtCommit.resolve()
          await allowACommitAckLoss.promise
          // Simulate a connection loss where the transaction was not applied.
          // withGedTransaction destroys the client and releases the lock.
          throw commitAckError
        }
        if (role === "of") {
          ofAtCommit.resolve()
          await allowOfCommit.promise
        }
        if (role === "b" && kind === "ack-b-first") {
          bAtCommit.resolve()
          await allowBCommit.promise
        }
        if (client.hasReference) committedReference = true
        releaseBlobLock(client)
        return { rows: [] }
      }

      if (sql === "ROLLBACK") {
        if (role === "cleanup-a" && kind === "cleanup-first") {
          cleanupDeletedBeforeRelease = await fs.stat(durablePath)
            .then(() => false)
            .catch(() => true)
        }
        releaseBlobLock(client)
        return { rows: [] }
      }

      if (sql.includes("COUNT(*)::bigint") && sql.includes("ged_document_versions")) {
        referenceQueries += 1
        if (role === "cleanup-a" && kind === "cleanup-first") {
          cleanupAtReference.resolve()
          await allowCleanupReference.promise
        }
        return {
          rows: [{
            blob_present: committedReference,
            reference_count: committedReference ? "1" : "0",
          }],
        }
      }

      if (sql.includes("SELECT d.id::text AS document_id") && sql.includes("LIMIT 1")) {
        if (role === "a" && kind !== "ack-b-first") {
          aAtFailure.resolve()
          await allowAFailure.promise
          throw aError
        }
        return { rows: [] }
      }

      if (sql.includes("INSERT INTO public.ged_blobs")) {
        if (role === "b" && kind === "both-rollback") {
          bAtFailure.resolve()
          await allowBFailure.promise
          throw bError
        }
        return { rows: [{ id: `blob-${role}` }] }
      }
      if (sql.includes("MAX(NULLIF")) return { rows: [{ next: 1 }] }
      if (sql.includes("INSERT INTO public.ged_documents")) {
        return { rows: [{ id: `document-${role}` }] }
      }
      if (sql.includes("INSERT INTO public.ged_document_versions")) {
        client.hasReference = true
        return { rows: [{ id: `version-${role}` }] }
      }
      return { rows: [] }
    }
    clients.push(client)
    return client
  })

  return {
    aError,
    bError,
    allowAFailure,
    aAtFailure,
    allowBFailure,
    bAtFailure,
    allowCleanupReference,
    cleanupAtReference,
    allowOfCommit,
    ofAtCommit,
    allowACommitAckLoss,
    aAtCommit,
    allowBCommit,
    bAtCommit,
    queued,
    get referenceQueries() { return referenceQueries },
    get cleanupDeletedBeforeRelease() { return cleanupDeletedBeforeRelease },
    commitAckError,
  }
}

let temporaryRoot: string
let vaultRoot: string

async function stagedFile(name: string) {
  const filePath = path.join(temporaryRoot, "staging", name)
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, VALID_PDF)
  return {
    path: filePath,
    originalname: "plan.pdf",
    mimetype: "application/pdf",
    size: VALID_PDF.byteLength,
    uploadSecurity: { sha256: SHA256 },
  }
}

function upload(file: Awaited<ReturnType<typeof stagedFile>>, title: string) {
  return uploadDocument(
    { id: 7, role: "Administrateur" },
    { class_key: "PLAN_CLIENT", title },
    file
  )
}

beforeEach(async () => {
  vi.clearAllMocks()
  clearRegisteredUploadDestinationsForTests()
  temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cerp-ged-concurrency-"))
  vaultRoot = path.join(temporaryRoot, "vault-root")
  await fs.mkdir(vaultRoot, { mode: 0o700 })
  process.env.CERP_GED_VAULT_ROOT = vaultRoot
  process.env.CERP_GED_REQUIRE_SENTINEL = "false"
})

afterEach(async () => {
  delete process.env.CERP_GED_VAULT_ROOT
  delete process.env.CERP_GED_REQUIRE_SENTINEL
  clearRegisteredUploadDestinationsForTests()
  await fs.rm(temporaryRoot, { recursive: true, force: true })
})

describe("GED same-SHA transaction coordination", () => {
  it("refuses an inconsistent OF fingerprint before locking or writing any blob", async () => {
    const tx = { query: vi.fn() }

    await expect(archiveOfDocument(tx, {
      ofNumero: "OF-42",
      revisionCode: "A",
      pieceReference: null,
      pdf: VALID_PDF,
      pdfSha256: "0".repeat(64),
      existingGedDocumentId: null,
      actorUserId: 7,
      changeReason: null,
    })).rejects.toThrow("Empreinte incohérente")

    expect(tx.query).not.toHaveBeenCalled()
    const durablePath = path.join(vaultRoot, storageKeyForSha256(SHA256))
    await expect(fs.stat(durablePath)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("never deletes a pre-existing deduplicated blob the failed upload does not own", async () => {
    const durablePath = path.join(vaultRoot, storageKeyForSha256(SHA256))
    await fs.mkdir(path.dirname(durablePath), { recursive: true })
    await fs.writeFile(durablePath, VALID_PDF)
    const scenario = installDatabaseScenario("cleanup-first", durablePath)
    const fileA = await stagedFile("a.pdf")

    const uploadA = upload(fileA, "A").catch((error) => error)
    await scenario.aAtFailure.promise
    scenario.allowAFailure.resolve()
    await scenario.cleanupAtReference.promise
    scenario.allowCleanupReference.resolve()

    expect(await uploadA).toBe(scenario.aError)
    expect(scenario.cleanupDeletedBeforeRelease).toBe(false)
    await expect(fs.readFile(durablePath)).resolves.toEqual(VALID_PDF)
  })

  it("lets cleanup delete first, then a waiting HTTP writer recreates and commits the blob", async () => {
    const durablePath = path.join(vaultRoot, storageKeyForSha256(SHA256))
    const scenario = installDatabaseScenario("cleanup-first", durablePath)
    const fileA = await stagedFile("a.pdf")
    const fileB = await stagedFile("b.pdf")

    const uploadA = upload(fileA, "A").catch((error) => error)
    await scenario.aAtFailure.promise
    scenario.allowAFailure.resolve()
    await scenario.cleanupAtReference.promise

    const uploadB = upload(fileB, "B").catch((error) => error)
    await scenario.queued.get("b")!.promise
    scenario.allowCleanupReference.resolve()

    expect(await uploadA).toBe(scenario.aError)
    await uploadB
    expect(scenario.cleanupDeletedBeforeRelease).toBe(true)
    await expect(fs.readFile(durablePath)).resolves.toEqual(VALID_PDF)
  })

  it("makes HTTP cleanup wait for an OF writer, then preserves its committed reference", async () => {
    const durablePath = path.join(vaultRoot, storageKeyForSha256(SHA256))
    const scenario = installDatabaseScenario("of-first", durablePath)
    const fileA = await stagedFile("a.pdf")

    const uploadA = upload(fileA, "A").catch((error) => error)
    await scenario.aAtFailure.promise

    const ofWriter = withOfTransaction((tx) => archiveOfDocument(tx, {
      ofNumero: "OF-42",
      revisionCode: "A",
      pieceReference: "P-42",
      pdf: VALID_PDF,
      pdfSha256: SHA256,
      existingGedDocumentId: null,
      actorUserId: 7,
      changeReason: "Emission",
    }))
    await scenario.queued.get("of")!.promise
    scenario.allowAFailure.resolve()
    await scenario.ofAtCommit.promise
    await scenario.queued.get("cleanup-a")!.promise

    // B/OF holds the SHA lock with an uncommitted reference. The cleanup query
    // cannot run in this invisible-refcount window.
    expect(scenario.referenceQueries).toBe(0)
    scenario.allowOfCommit.resolve()

    await expect(ofWriter).resolves.toMatchObject({ archived: true })
    expect(await uploadA).toBe(scenario.aError)
    expect(scenario.referenceQueries).toBe(1)
    await expect(fs.readFile(durablePath)).resolves.toEqual(VALID_PDF)
  })

  it("coordinates the no-COMMIT reconciliation path after a lost ACK with a waiting writer", async () => {
    const durablePath = path.join(vaultRoot, storageKeyForSha256(SHA256))
    const scenario = installDatabaseScenario("ack-b-first", durablePath)
    const fileA = await stagedFile("a.pdf")
    const fileB = await stagedFile("b.pdf")

    const uploadA = upload(fileA, "A").catch((error) => error)
    await scenario.aAtCommit.promise
    const uploadB = upload(fileB, "B").catch((error) => error)
    await scenario.queued.get("b")!.promise
    scenario.allowACommitAckLoss.resolve()
    await scenario.bAtCommit.promise
    await scenario.queued.get("cleanup-a")!.promise

    expect(scenario.referenceQueries).toBe(0)
    scenario.allowBCommit.resolve()

    expect(await uploadA).toBe(scenario.commitAckError)
    await uploadB
    expect(scenario.referenceQueries).toBe(1)
    await expect(fs.readFile(durablePath)).resolves.toEqual(VALID_PDF)
  })

  it("removes the shared orphan when both interleaved HTTP writers roll back", async () => {
    const durablePath = path.join(vaultRoot, storageKeyForSha256(SHA256))
    const scenario = installDatabaseScenario("both-rollback", durablePath)
    const fileA = await stagedFile("a.pdf")
    const fileB = await stagedFile("b.pdf")

    const uploadA = upload(fileA, "A").catch((error) => error)
    await scenario.aAtFailure.promise
    const uploadB = upload(fileB, "B").catch((error) => error)
    await scenario.queued.get("b")!.promise
    scenario.allowAFailure.resolve()
    await scenario.bAtFailure.promise
    await scenario.queued.get("cleanup-a")!.promise
    scenario.allowBFailure.resolve()

    expect(await uploadA).toBe(scenario.aError)
    expect(await uploadB).toBe(scenario.bError)
    await expect(fs.stat(durablePath)).rejects.toMatchObject({ code: "ENOENT" })
  })
})
