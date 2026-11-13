import express, { type ErrorRequestHandler } from "express"
import fs from "node:fs/promises"
import path from "node:path"
import request from "supertest"
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ linked: vi.fn(), filePath: vi.fn(), name: vi.fn(), remove: vi.fn() }))
vi.mock("../module/livraisons/repository/livraisons.repository", () => ({
  repoIsLivraisonDocumentLinked: (...args: unknown[]) => mocks.linked(...args),
  repoFindDocumentFilePath: (...args: unknown[]) => mocks.filePath(...args),
  repoGetDocumentName: (...args: unknown[]) => mocks.name(...args),
}))
vi.mock("../module/livraisons/services/livraisons.service", () => ({
  svcRemoveLivraisonDocument: (...args: unknown[]) => mocks.remove(...args),
}))
vi.mock("../module/livraisons/services/pdf.service", () => ({}))
vi.mock("../module/livraisons/services/pack.service", () => ({}))
vi.mock("../module/livraisons/repository/quality-dossier.repository", () => ({}))

import { downloadLivraisonPackDocument } from "../module/livraisons/controllers/pack.controller"
import { deleteLivraisonDocument, getLivraisonDocumentFile } from "../module/livraisons/controllers/livraisons.controller"
import { validationErrorMiddleware } from "../module/auth/middlewares/validationError.middleware"
import { getDocumentStoragePath } from "../utils/cerpStorage"

const BL = "11111111-1111-4111-8111-111111111111"
const DOC = "22222222-2222-4222-8222-222222222222"
const COFC = "33333333-3333-4333-8333-333333333333"
const bytes = Buffer.from("%PDF-1.7\narchived-recipe-document\n%%EOF")
const routes = [
  { kind: "pack", method: "get", url: `/livraisons/${BL}/pack/download/${DOC}` },
  { kind: "attached", method: "get", url: `/livraisons/${BL}/documents/${DOC}/file` },
  { kind: "remove", method: "delete", url: `/livraisons/${BL}/documents/${DOC}` },
] as const

function app() {
  const server = express()
  server.use((req, _res, next) => {
    if (req.headers["x-recipe-user"] === "present") req.user = { id: 7 } as Express.User
    next()
  })
  server.get("/livraisons/:id/pack/download/:documentId", downloadLivraisonPackDocument)
  server.get("/livraisons/:id/documents/:docId/file", getLivraisonDocumentFile)
  server.delete("/livraisons/:id/documents/:docId", deleteLivraisonDocument)
  // Extra named route parameters exercise strictness, rather than bypassing Express parsing.
  server.get("/extra/livraisons/:id/pack/download/:documentId/:unexpected", downloadLivraisonPackDocument)
  server.get("/extra/livraisons/:id/documents/:docId/file/:unexpected", getLivraisonDocumentFile)
  server.delete("/extra/livraisons/:id/documents/:docId/:unexpected", deleteLivraisonDocument)
  server.use(validationErrorMiddleware)
  server.use(((error: { status?: number; code?: string }, _req, res, _next) => {
    res.status(error.status ?? 500).json({ code: error.code ?? "UNEXPECTED" })
  }) as ErrorRequestHandler)
  return server
}

let archive: string
beforeAll(async () => {
  const root = getDocumentStoragePath("livraisons")
  await fs.mkdir(root, { recursive: true })
  archive = path.join(root, "route-1102-archive.pdf")
  await fs.writeFile(archive, bytes)
})
beforeEach(() => {
  vi.clearAllMocks()
  mocks.linked.mockResolvedValue(true)
  mocks.filePath.mockResolvedValue(archive)
  mocks.name.mockResolvedValue("BL-test-archive.pdf")
  mocks.remove.mockResolvedValue(true)
})

describe("delivery archived document route parameters", () => {
  it.each([DOC, COFC])("serves archived pack PDF %s through the actual secure sender", async documentId => {
    const response = await request(app()).get(`/livraisons/${BL}/pack/download/${documentId}`).set("x-recipe-user", "present")
    expect(response.status).toBe(200)
    expect(response.body).toEqual(bytes)
    expect(response.headers["content-type"]).toContain("application/pdf")
    expect(response.headers["content-disposition"]).toContain("inline;")
    expect(response.headers["cache-control"]).toBe("private, no-store, max-age=0")
    expect(mocks.linked).toHaveBeenCalledWith(BL, documentId)
  })

  it("supports the explicit attachment option without regenerating bytes", async () => {
    const response = await request(app()).get(routes[0].url + "?download=true").set("x-recipe-user", "present")
    expect(response.status).toBe(200)
    expect(response.headers["content-disposition"]).toContain("attachment;")
    expect(response.body).toEqual(bytes)
  })

  it("serves the linked ordinary document from the bounded storage root", async () => {
    const response = await request(app()).get(routes[1].url).set("x-recipe-user", "present")
    expect(response.status).toBe(200)
    expect(response.headers["content-length"]).toBe(String(bytes.length))
    expect(mocks.filePath).toHaveBeenCalledWith(DOC)
  })

  it("delegates removal to the existing audited service with its actor", async () => {
    const response = await request(app()).delete(routes[2].url).set("x-recipe-user", "present")
    expect(response.status).toBe(204)
    expect(mocks.remove).toHaveBeenCalledWith({ bonLivraisonId: BL, documentId: DOC, userId: 7 })
    expect(mocks.filePath).not.toHaveBeenCalled()
  })

  it.each(routes)("rejects missing authentication for $kind before lookup", async route => {
    const response = await request(app())[route.method](route.url)
    expect(response.status).toBe(401)
    expect(mocks.linked).not.toHaveBeenCalled()
    expect(mocks.filePath).not.toHaveBeenCalled()
    expect(mocks.remove).not.toHaveBeenCalled()
  })

  it.each(routes)("rejects invalid document UUID for $kind before lookup", async route => {
    const response = await request(app())[route.method](route.url.replace(DOC, "not-a-uuid")).set("x-recipe-user", "present")
    expect(response.status).toBe(400)
    expect(response.body.error).toBe("VALIDATION_ERROR")
    expect(mocks.linked).not.toHaveBeenCalled()
    expect(mocks.filePath).not.toHaveBeenCalled()
    expect(mocks.remove).not.toHaveBeenCalled()
  })

  it.each(routes)("keeps unexpected parameter refusal for $kind", async route => {
    const response = await request(app())[route.method]("/extra" + route.url + "/unknown").set("x-recipe-user", "present")
    expect(response.status).toBe(400)
    expect(response.body.error).toBe("VALIDATION_ERROR")
    expect(mocks.linked).not.toHaveBeenCalled()
    expect(mocks.filePath).not.toHaveBeenCalled()
    expect(mocks.remove).not.toHaveBeenCalled()
  })

  it.each(routes.slice(0, 2))("refuses a document from another BL for $kind", async route => {
    mocks.linked.mockResolvedValue(false)
    const response = await request(app()).get(route.url).set("x-recipe-user", "present")
    expect(response.status).toBe(404)
    expect(mocks.filePath).not.toHaveBeenCalled()
  })

  it.each(routes.slice(0, 2))("preserves missing archive refusal for $kind", async route => {
    mocks.filePath.mockResolvedValue(null)
    const response = await request(app()).get(route.url).set("x-recipe-user", "present")
    expect(response.status).toBe(404)
    expect(mocks.name).not.toHaveBeenCalled()
  })

  it.each(routes.slice(0, 2))("preserves the actual secure root boundary for $kind", async route => {
    const outside = path.join(process.env.CERP_VITEST_WORKER_ROOT!, "outside-route-1102.pdf")
    await fs.writeFile(outside, bytes)
    mocks.filePath.mockResolvedValue(outside)
    const response = await request(app()).get(route.url).set("x-recipe-user", "present")
    expect(response.status).toBe(400)
    expect(response.body.code).toBe("INVALID_STORAGE_PATH")
    expect(response.body).not.toEqual(bytes)
  })

  it("preserves the existing removal conflict instead of returning success", async () => {
    mocks.remove.mockRejectedValue(Object.assign(new Error("Frozen document"), { status: 409, code: "DOCUMENT_FROZEN" }))
    const response = await request(app()).delete(routes[2].url).set("x-recipe-user", "present")
    expect(response.status).toBe(409)
    expect(response.body.code).toBe("DOCUMENT_FROZEN")
  })
})
