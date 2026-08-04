import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import express from "express"
import request from "supertest"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const database = vi.hoisted(() => ({
  connect: vi.fn(),
  query: vi.fn(),
  clientQuery: vi.fn(),
  release: vi.fn(),
}))

vi.mock("../config/database", () => ({
  default: {
    connect: database.connect,
    query: database.query,
  },
}))

import { uploadDocument } from "../module/ged/services/ged.service"
import {
  clearRegisteredUploadDestinationsForTests,
  createSecureUpload,
  getRegisteredUploadDestinationCountForTests,
} from "../shared/uploads/secure-upload"

const VALID_PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n")
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

let temporaryRoot: string
let restorePromotionGate: (() => void) | undefined

function configureClassLookup() {
  database.query.mockImplementation(async (sql: string) => {
    if (sql.includes("FROM public.ged_document_classes")) return { rows: [CLASS_ROW] }
    throw new Error("fresh reconciliation unavailable")
  })
}

function configureCommitAckLoss() {
  database.clientQuery.mockImplementation(async (sql: string) => {
    if (sql === "COMMIT") throw new Error("commit acknowledgement lost")
    if (sql.includes("INSERT INTO public.ged_blobs")) return { rows: [{ id: "blob-id" }] }
    if (sql.includes("MAX(NULLIF")) return { rows: [{ next: 1 }] }
    if (sql.includes("INSERT INTO public.ged_documents")) return { rows: [{ id: "document-id" }] }
    if (sql.includes("INSERT INTO public.ged_document_versions")) return { rows: [{ id: "version-id" }] }
    return { rows: [] }
  })
}

function configureRollbackAckLoss() {
  database.clientQuery.mockImplementation(async (sql: string) => {
    if (sql === "BEGIN") return { rows: [] }
    if (sql.includes("pg_advisory_xact_lock")) return { rows: [] }
    if (sql === "ROLLBACK") throw new Error("rollback acknowledgement lost")
    throw new Error("business mutation failed")
  })
}

function installVaultPromotionGate(vaultRoot: string) {
  const originalLink = fs.link.bind(fs)
  let releasePromotion!: () => void
  let signalPromotion!: () => void
  const promotionReached = new Promise<void>((resolve) => { signalPromotion = resolve })
  const promotionReleased = new Promise<void>((resolve) => { releasePromotion = resolve })
  const spy = vi.spyOn(fs, "link").mockImplementation(async (source, destination) => {
    await originalLink(source, destination)
    if (path.resolve(String(destination)).startsWith(path.resolve(vaultRoot) + path.sep)) {
      signalPromotion()
      await promotionReleased
    }
  })
  restorePromotionGate = () => spy.mockRestore()
  return { promotionReached, releasePromotion }
}

function lifecycleApp(
  promotionReached: Promise<void>,
  releasePromotion: () => void,
  observe: (error: unknown) => void,
  done: () => void
) {
  const app = express()
  const upload = createSecureUpload("ged-deferred", { storage: "staging" })
  app.post("/ged", upload.single("file"), async (req, res) => {
    const serviceResult = uploadDocument(
      { id: 7, role: "Administrateur" },
      { class_key: "PLAN_CLIENT", title: "Plan test" },
      req.file
    ).catch((error) => {
      observe(error)
    })

    await promotionReached
    res.socket?.destroy()
    // Let the central `close` lifecycle run before the vault registers the
    // destination. This is the race that previously lost Multer identity.
    await new Promise((resolve) => setTimeout(resolve, 10))
    releasePromotion()
    await serviceResult
    done()
  })
  return app
}

async function runCloseBeforeRegistrationScenario() {
  const vaultRoot = path.join(temporaryRoot, "vault-root")
  const gate = installVaultPromotionGate(vaultRoot)
  let observedError: unknown
  let finish!: () => void
  const finished = new Promise<void>((resolve) => { finish = resolve })
  const app = lifecycleApp(gate.promotionReached, gate.releasePromotion, (error) => {
    observedError = error
  }, finish)

  await request(app)
    .post("/ged")
    .attach("file", VALID_PDF, { filename: "plan.pdf", contentType: "application/pdf" })
    .catch(() => undefined)
  await finished
  await new Promise((resolve) => setTimeout(resolve, 20))

  return { observedError, vaultRoot }
}

beforeEach(async () => {
  vi.clearAllMocks()
  clearRegisteredUploadDestinationsForTests()
  temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cerp-ged-lifecycle-"))
  await fs.mkdir(path.join(temporaryRoot, "tmp"), { mode: 0o700 })
  await fs.mkdir(path.join(temporaryRoot, "vault-root"), { mode: 0o700 })
  process.env.CERP_TMP_ROOT = path.join(temporaryRoot, "tmp")
  process.env.CERP_GED_VAULT_ROOT = path.join(temporaryRoot, "vault-root")
  process.env.CERP_GED_REQUIRE_SENTINEL = "false"
  process.env.CERP_UPLOAD_SCAN_MODE = "off"
  database.connect.mockResolvedValue({ query: database.clientQuery, release: database.release })
  configureClassLookup()
})

afterEach(async () => {
  restorePromotionGate?.()
  restorePromotionGate = undefined
  delete process.env.CERP_TMP_ROOT
  delete process.env.CERP_GED_VAULT_ROOT
  delete process.env.CERP_GED_REQUIRE_SENTINEL
  delete process.env.CERP_UPLOAD_SCAN_MODE
  clearRegisteredUploadDestinationsForTests()
  await fs.rm(temporaryRoot, { recursive: true, force: true })
})

describe("GED upload lifecycle ownership", () => {
  it("releases a close-before-register entry after commit reconciliation stays uncertain", async () => {
    configureCommitAckLoss()

    const { observedError, vaultRoot } = await runCloseBeforeRegistrationScenario()

    expect(observedError).toMatchObject({ code: "GED_COMMIT_UNCERTAIN", status: 503 })
    expect(getRegisteredUploadDestinationCountForTests()).toBe(0)
    const durableFiles = await fs.readdir(path.join(vaultRoot, "vault", "sha256"), { recursive: true })
    expect(durableFiles.length).toBeGreaterThan(0)
  })

  it("releases a close-before-register entry after rollback acknowledgement stays uncertain", async () => {
    configureRollbackAckLoss()

    const { observedError, vaultRoot } = await runCloseBeforeRegistrationScenario()

    expect(observedError).toMatchObject({ code: "GED_ROLLBACK_UNCERTAIN", status: 503 })
    expect(getRegisteredUploadDestinationCountForTests()).toBe(0)
    const durableFiles = await fs.readdir(path.join(vaultRoot, "vault", "sha256"), { recursive: true })
    expect(durableFiles.length).toBeGreaterThan(0)
  })
})
