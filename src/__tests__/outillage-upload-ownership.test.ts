import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import express, { type ErrorRequestHandler } from "express"
import request from "supertest"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { HttpError } from "../utils/httpError"

const database = vi.hoisted(() => ({
  connect: vi.fn(),
  query: vi.fn(),
  clientQuery: vi.fn(),
  release: vi.fn(),
}))

const repository = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  setOutilUploadPaths: vi.fn(),
  createFamille: vi.fn(),
  updateFamille: vi.fn(),
  setFamilleImagePath: vi.fn(),
  createFabricant: vi.fn(),
  updateFabricant: vi.fn(),
  setFabricantLogo: vi.fn(),
  createGeometrie: vi.fn(),
  updateGeometrie: vi.fn(),
  setGeometrieImagePath: vi.fn(),
}))

vi.mock("../config/database", () => ({
  default: {
    connect: database.connect,
    query: database.query,
  },
}))

vi.mock("../module/outils/repository/outil.repository", () => ({
  outilRepository: repository,
}))

vi.mock("../sockets/sockeServer", () => ({
  getIO: () => ({ emit: vi.fn() }),
}))

import { createImageUpload } from "../middlewares/upload"
import { outilController } from "../module/outils/controllers/outil.controller"
import { outilService, outilSupportService } from "../module/outils/services/outil.service"
import {
  clearRegisteredUploadDestinationsForTests,
  getRegisteredUploadDestinationCountForTests,
} from "../shared/uploads/secure-upload"

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

type UploadKind = "outil" | "famille" | "fabricant" | "geometrie"
type Reconciliation = "present" | "absent" | "unknown"
type MutationOperation = "create" | "update"

const MUTATION_CASES: readonly (readonly [MutationOperation, UploadKind])[] = [
  ["create", "outil"],
  ["create", "famille"],
  ["create", "fabricant"],
  ["create", "geometrie"],
  ["update", "outil"],
  ["update", "famille"],
  ["update", "fabricant"],
  ["update", "geometrie"],
]

let temporaryRoot: string
let sequence = 0

function client() {
  return { query: database.clientQuery, release: database.release }
}

function toolPayload() {
  return {
    id_fabricant: 1,
    id_famille: 2,
    id_geometrie: null,
    codification: "T-001",
    designation_outil_cnc: "Fraise",
    reference_fabricant: "REF-001",
    fournisseurs: [],
    revetements: [],
    prix_fournisseurs: [],
    valeurs_aretes: [],
    quantite_stock: 0,
    quantite_minimale: 0,
    stock_initial_reason: "creation_outil",
    utilisateur: "test-admin",
    user_id: 1,
  } as any
}

async function stagedFile(label: string): Promise<Express.Multer.File> {
  const staging = path.join(temporaryRoot, "manual-staging")
  await fs.mkdir(staging, { recursive: true })
  const filePath = path.join(staging, `${label}-${sequence++}.part`)
  const contents = Buffer.concat([PNG_SIGNATURE, Buffer.from(label), Buffer.from([sequence])])
  await fs.writeFile(filePath, contents)
  return {
    fieldname: label,
    originalname: `${label}.png`,
    encoding: "7bit",
    mimetype: "image/png",
    size: contents.length,
    destination: staging,
    filename: path.basename(filePath),
    path: filePath,
    buffer: Buffer.alloc(0),
  }
}

async function allFiles(directory: string): Promise<string[]> {
  const entries = await fs.readdir(directory, { recursive: true, withFileTypes: true }).catch(() => [])
  return entries.filter((entry) => entry.isFile()).map((entry) => entry.name)
}

async function waitForNoFiles(directory: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if ((await allFiles(directory)).length === 0) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }

  expect(await allFiles(directory)).toEqual([])
}

function matchingFreshRow(kind: UploadKind): Record<string, unknown> {
  if (kind === "outil") {
    const paths = repository.setOutilUploadPaths.mock.calls.at(-1)?.[2] as Record<string, string>
    return { esquisse: paths.esquisse, plan: paths.plan, image: paths.image }
  }
  if (kind === "famille") return { image_path: repository.setFamilleImagePath.mock.calls.at(-1)?.[2] }
  if (kind === "fabricant") return { logo: repository.setFabricantLogo.mock.calls.at(-1)?.[2] }
  return { image_path: repository.setGeometrieImagePath.mock.calls.at(-1)?.[2] }
}

async function invokeMutation(kind: UploadKind, operation: MutationOperation = "create") {
  if (kind === "outil") {
    const files = {
      esquisse: await stagedFile("esquisse"),
      plan: await stagedFile("plan"),
      image: await stagedFile("image"),
    }
    return operation === "create"
      ? outilService.createOutil(toolPayload(), files)
      : outilService.updateOutil(42, toolPayload(), files)
  }
  const file = await stagedFile(kind)
  if (kind === "famille") return operation === "create"
    ? outilSupportService.createFamille("Fraises", file)
    : outilSupportService.updateFamille(11, "Fraises", file)
  if (kind === "fabricant") return operation === "create"
    ? outilSupportService.createFabricant("Seco", file, [7])
    : outilSupportService.updateFabricant(12, "Seco", file, [7])
  return operation === "create"
    ? outilSupportService.createGeometrie("Torique", 2, file)
    : outilSupportService.updateGeometrie(13, "Torique", 2, file)
}

function configureCommitAckLoss(kind: UploadKind, outcome: Reconciliation) {
  database.clientQuery.mockImplementation(async (sql: string) => {
    if (sql === "COMMIT") throw new Error("commit acknowledgement lost")
    return { rows: [] }
  })
  database.query.mockImplementation(async () => {
    if (outcome === "absent") return { rows: [] }
    if (outcome === "unknown") throw new Error("fresh reconciliation unavailable")
    return { rows: [matchingFreshRow(kind)] }
  })
}

function errorHandler(): ErrorRequestHandler {
  return (error, _req, res, _next) => {
    res.status(error instanceof HttpError ? error.status : 500).json({
      code: error instanceof HttpError ? error.code : "INTERNAL_ERROR",
    })
  }
}

function outilUploadApp() {
  const app = express()
  const fields = () => createImageUpload("outillage/outils", "tool-media").fields([
    { name: "esquisse", maxCount: 1 },
    { name: "plan", maxCount: 1 },
    { name: "image", maxCount: 1 },
  ])
  const authenticate = (
    req: express.Request,
    _res: express.Response,
    next: express.NextFunction
  ) => {
    req.user = { id: 1, username: "test-admin", email: "admin@example.test", role: "administrateur" }
    next()
  }
  app.post(
    "/outils",
    authenticate,
    fields(),
    (req, res, next) => { void outilController.create(req, res, next).catch(next) }
  )
  app.patch(
    "/outils/:id",
    authenticate,
    fields(),
    (req, _res, next) => {
      next()
    },
    (req, res, next) => { void outilController.update(req, res, next).catch(next) }
  )
  app.use(errorHandler())
  return app
}

async function postThreeToolFiles(data: string) {
  return request(outilUploadApp())
    .post("/outils")
    .field("data", data)
    .attach("esquisse", Buffer.concat([PNG_SIGNATURE, Buffer.from("a")]), { filename: "esquisse.png", contentType: "image/png" })
    .attach("plan", Buffer.concat([PNG_SIGNATURE, Buffer.from("b")]), { filename: "plan.png", contentType: "image/png" })
    .attach("image", Buffer.concat([PNG_SIGNATURE, Buffer.from("c")]), { filename: "image.png", contentType: "image/png" })
}

async function patchThreeToolFiles(data: string) {
  return request(outilUploadApp())
    .patch("/outils/42")
    .field("data", data)
    .attach("esquisse", Buffer.concat([PNG_SIGNATURE, Buffer.from("d")]), { filename: "esquisse.png", contentType: "image/png" })
    .attach("plan", Buffer.concat([PNG_SIGNATURE, Buffer.from("e")]), { filename: "plan.png", contentType: "image/png" })
    .attach("image", Buffer.concat([PNG_SIGNATURE, Buffer.from("f")]), { filename: "image.png", contentType: "image/png" })
}

beforeEach(async () => {
  vi.clearAllMocks()
  clearRegisteredUploadDestinationsForTests()
  sequence = 0
  temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cerp-outillage-upload-"))
  await fs.mkdir(path.join(temporaryRoot, "tmp"), { mode: 0o700 })
  await fs.mkdir(path.join(temporaryRoot, "images"), { mode: 0o700 })
  process.env.CERP_TMP_ROOT = path.join(temporaryRoot, "tmp")
  process.env.CERP_IMAGES_ROOT = path.join(temporaryRoot, "images")
  process.env.CERP_UPLOAD_SCAN_MODE = "off"

  database.connect.mockImplementation(async () => client())
  database.query.mockResolvedValue({ rows: [] })
  database.clientQuery.mockResolvedValue({ rows: [] })
  repository.create.mockResolvedValue(42)
  repository.update.mockResolvedValue(undefined)
  repository.setOutilUploadPaths.mockResolvedValue(undefined)
  repository.createFamille.mockResolvedValue({ value: 11, label: "FRAISES", imagePath: null })
  repository.updateFamille.mockResolvedValue({ value: 11, label: "FRAISES", imagePath: null })
  repository.setFamilleImagePath.mockResolvedValue(undefined)
  repository.createFabricant.mockResolvedValue(12)
  repository.updateFabricant.mockResolvedValue({ value: 12, label: "Seco", logo: null })
  repository.setFabricantLogo.mockResolvedValue(undefined)
  repository.createGeometrie.mockResolvedValue({ value: 13, label: "TORIQUE", id_famille: 2, imagePath: null })
  repository.updateGeometrie.mockResolvedValue({ value: 13, label: "TORIQUE", id_famille: 2, imagePath: null })
  repository.setGeometrieImagePath.mockResolvedValue(undefined)
})

afterEach(async () => {
  delete process.env.CERP_TMP_ROOT
  delete process.env.CERP_IMAGES_ROOT
  delete process.env.CERP_UPLOAD_SCAN_MODE
  await fs.rm(temporaryRoot, { recursive: true, force: true })
})

describe("Outillage staging avant handler", () => {
  it.each([
    [422, new HttpError(422, "BUSINESS_REJECTED", "validation metier")],
    [500, new Error("downstream failure")],
  ] as const)("ne laisse aucun durable après une réponse aval %i", async (status, failure) => {
    repository.create.mockRejectedValueOnce(failure)
    const response = await postThreeToolFiles(JSON.stringify(toolPayload()))

    expect(response.status).toBe(status)
    await waitForNoFiles(path.join(temporaryRoot, "tmp"))
    expect(await allFiles(path.join(temporaryRoot, "images"))).toEqual([])
  })

  it("nettoie les trois fichiers si le JSON multipart est invalide, sans ouvrir de transaction", async () => {
    const response = await postThreeToolFiles("{not-json")

    expect(response.status).toBe(400)
    expect(response.body.code).toBe("INVALID_JSON")
    expect(database.connect).not.toHaveBeenCalled()
    await waitForNoFiles(path.join(temporaryRoot, "tmp"))
    expect(await allFiles(path.join(temporaryRoot, "images"))).toEqual([])
  })

  it("nettoie aussi les trois fichiers d'un PATCH si sa validation multipart échoue", async () => {
    const response = await patchThreeToolFiles("{still-not-json")

    expect(response.status).toBe(400)
    expect(response.body.code).toBe("INVALID_JSON")
    expect(database.connect).not.toHaveBeenCalled()
    await waitForNoFiles(path.join(temporaryRoot, "tmp"))
    expect(await allFiles(path.join(temporaryRoot, "images"))).toEqual([])
  })
})

describe("transactions propriétaires Outillage", () => {
  it.each(MUTATION_CASES)(
    "%s %s promeut seulement après la validation métier et marque le commit réussi",
    async (operation, kind) => {
      await invokeMutation(kind, operation)

      expect(database.clientQuery.mock.calls.map(([sql]) => sql)).toEqual(["BEGIN", "COMMIT"])
      expect(database.release).toHaveBeenCalledWith(false)
      const expectedCount = kind === "outil" ? 3 : 1
      expect(await allFiles(path.join(temporaryRoot, "images"))).toHaveLength(expectedCount)
    }
  )

  it.each(MUTATION_CASES)(
    "%s %s garde le fichier en staging quand la validation SQL échoue et confirme le rollback",
    async (operation, kind) => {
      const mutationMock = kind === "outil"
        ? repository[operation]
        : kind === "famille"
          ? repository[operation === "create" ? "createFamille" : "updateFamille"]
          : kind === "fabricant"
            ? repository[operation === "create" ? "createFabricant" : "updateFabricant"]
            : repository[operation === "create" ? "createGeometrie" : "updateGeometrie"]
      mutationMock.mockRejectedValueOnce(new HttpError(422, "BUSINESS_REJECTED", "validation metier"))

      await expect(invokeMutation(kind, operation)).rejects.toMatchObject({ code: "BUSINESS_REJECTED" })

      expect(database.clientQuery.mock.calls.map(([sql]) => sql)).toEqual(["BEGIN", "ROLLBACK"])
      expect(await allFiles(path.join(temporaryRoot, "images"))).toEqual([])
      expect(await allFiles(path.join(temporaryRoot, "manual-staging"))).toHaveLength(kind === "outil" ? 3 : 1)
    }
  )

  it.each(MUTATION_CASES)(
    "%s %s conserve le durable et retourne le succès après ACK perdu réconcilié présent",
    async (operation, kind) => {
      configureCommitAckLoss(kind, "present")

      await expect(invokeMutation(kind, operation)).resolves.toBeDefined()

      expect(database.clientQuery.mock.calls.map(([sql]) => sql)).toEqual(["BEGIN", "COMMIT"])
      expect(database.release).toHaveBeenCalledWith(true)
      expect(await allFiles(path.join(temporaryRoot, "images"))).toHaveLength(kind === "outil" ? 3 : 1)
    }
  )

  it.each(MUTATION_CASES)(
    "%s %s nettoie le durable après ACK perdu réconcilié absent",
    async (operation, kind) => {
      configureCommitAckLoss(kind, "absent")

      await expect(invokeMutation(kind, operation)).rejects.toThrow("commit acknowledgement lost")

      expect(database.clientQuery.mock.calls.map(([sql]) => sql)).toEqual(["BEGIN", "COMMIT"])
      expect(await allFiles(path.join(temporaryRoot, "images"))).toEqual([])
    }
  )

  it.each(MUTATION_CASES)(
    "%s %s préserve le durable avec 503 après ACK perdu réconcilié inconnu",
    async (operation, kind) => {
      configureCommitAckLoss(kind, "unknown")

      await expect(invokeMutation(kind, operation)).rejects.toMatchObject({ code: "UPLOAD_COMMIT_UNCERTAIN", status: 503 })

      expect(database.clientQuery.mock.calls.map(([sql]) => sql)).toEqual(["BEGIN", "COMMIT"])
      expect(await allFiles(path.join(temporaryRoot, "images"))).toHaveLength(kind === "outil" ? 3 : 1)
    }
  )

  it("préserve le durable Outillage si le client se déconnecte après le commit", async () => {
    const app = express()
    const upload = createImageUpload("outillage/familles")
    app.post("/famille", upload.single("image"), async (req, res, next) => {
      try {
        await outilSupportService.createFamille("Fraises", req.file)
        res.socket?.destroy()
      } catch (error) {
        next(error)
      }
    })
    app.use(errorHandler())

    await request(app)
      .post("/famille")
      .attach("image", Buffer.concat([PNG_SIGNATURE, Buffer.from("disconnect")]), {
        filename: "famille.png",
        contentType: "image/png",
      })
      .catch(() => undefined)

    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(await allFiles(path.join(temporaryRoot, "images"))).toHaveLength(1)
    expect(getRegisteredUploadDestinationCountForTests()).toBe(0)
  })
})
