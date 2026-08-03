import express from "express"
import request from "supertest"
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  listGammesByVersion: vi.fn(),
  createGamme: vi.fn(),
  updateGamme: vi.fn(),
  createGammeRevision: vi.fn(),
  listGammeOperations: vi.fn(),
  addGammeOperation: vi.fn(),
  updateGammeOperation: vi.fn(),
  deleteGammeOperation: vi.fn(),
  nextPhase: vi.fn(),
  reorderGammeOperations: vi.fn(),
  gammePublicationReadiness: vi.fn(),
  publishGamme: vi.fn(),
  listVersions: vi.fn(),
  createVersion: vi.fn(),
  updateVersion: vi.fn(),
  updateVersionStatus: vi.fn(),
  publishVersion: vi.fn(),
  createNextVersion: vi.fn(),
}))

vi.mock("../module/gammes/services/gammes.service", () => ({
  listGammesByVersionSVC: mocks.listGammesByVersion,
  createGammeSVC: mocks.createGamme,
  updateGammeSVC: mocks.updateGamme,
  createGammeRevisionSVC: mocks.createGammeRevision,
  listGammeOperationsSVC: mocks.listGammeOperations,
  addGammeOperationSVC: mocks.addGammeOperation,
  updateGammeOperationSVC: mocks.updateGammeOperation,
  deleteGammeOperationSVC: mocks.deleteGammeOperation,
  nextPhaseSVC: mocks.nextPhase,
  reorderGammeOperationsSVC: mocks.reorderGammeOperations,
  gammePublicationReadinessSVC: mocks.gammePublicationReadiness,
  publishGammeSVC: mocks.publishGamme,
}))

vi.mock("../module/pieces-techniques/services/versions.service", () => ({
  listVersionsSVC: mocks.listVersions,
  createVersionSVC: mocks.createVersion,
  updateVersionSVC: mocks.updateVersion,
  updateVersionStatusSVC: mocks.updateVersionStatus,
  publishVersionSVC: mocks.publishVersion,
  createNextVersionSVC: mocks.createNextVersion,
}))

vi.mock("../module/auth/middlewares/auth.middleware", () => ({
  authenticateToken: (req: { user?: Record<string, unknown> }, _res: unknown, next: () => void) => {
    req.user = {
      id: 1,
      username: "test-admin",
      email: "admin@example.test",
      role: "Administrateur Systeme et Reseau",
    }
    next()
  },
  authorizeRole: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}))

vi.mock("../module/methodes/middlewares/methodes-authorization.middleware", () => ({
  requireMethodesCapability: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}))

vi.mock("../utils/cerpStorage", () => ({
  ensureDocumentStoragePath: () => process.cwd(),
}))

import gammesRoutes from "../module/gammes/routes/gammes.routes"
import pieceTechniqueVersionsRoutes from "../module/gammes/routes/piece-technique-versions.routes"
import piecesTechniquesRoutes from "../module/pieces-techniques/routes/pieces-techniques.routes"
import { validationErrorMiddleware } from "../module/auth/middlewares/validationError.middleware"
import { errorHandler } from "../middlewares/errorHandler"

const PIECE_ID = "11111111-1111-4111-8111-111111111111"
const VERSION_ID = "22222222-2222-4222-8222-222222222222"
const GAMME_ID = "33333333-3333-4333-8333-333333333333"
const OPERATION_ID = "44444444-4444-4444-8444-444444444444"

const app = express()
app.use(express.json())
app.use("/piece-technique-versions", pieceTechniqueVersionsRoutes)
app.use("/gammes", gammesRoutes)
app.use("/pieces-techniques", piecesTechniquesRoutes)
app.use(validationErrorMiddleware)
app.use(errorHandler)

const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)

beforeEach(() => {
  vi.clearAllMocks()
  mocks.listGammesByVersion.mockResolvedValue([])
  mocks.createGamme.mockResolvedValue({ id: GAMME_ID })
  mocks.updateGamme.mockResolvedValue({ id: GAMME_ID })
  mocks.listGammeOperations.mockResolvedValue([])
  mocks.addGammeOperation.mockResolvedValue({ id: OPERATION_ID })
  mocks.reorderGammeOperations.mockResolvedValue([{ id: OPERATION_ID }])
  mocks.listVersions.mockResolvedValue([])
  mocks.createVersion.mockResolvedValue({ id: VERSION_ID })
  mocks.updateVersion.mockResolvedValue({ id: VERSION_ID })
  mocks.updateVersionStatus.mockResolvedValue({ id: VERSION_ID, statut: "EN_VALIDATION" })
  mocks.createNextVersion.mockResolvedValue({ id: VERSION_ID })
})

afterAll(() => {
  consoleError.mockRestore()
})

describe("Routes/contrôleurs gammes et versions", () => {
  it.each([
    ["/piece-technique-versions/not-a-uuid/gammes", "versionId"],
    ["/gammes/not-a-uuid/operations", "gammeId"],
    ["/pieces-techniques/not-a-uuid/versions", "id"],
  ])("renvoie 400 avant le service pour %s", async (path, paramName) => {
    const response = await request(app).get(path)

    expect(response.status).toBe(400)
    expect(response.body).toMatchObject({ error: "VALIDATION_ERROR" })
    expect(response.body.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ message: expect.stringContaining(paramName) })])
    )
  })

  it("préserve les six appels nominaux gamme, dont création et réordonnancement", async () => {
    expect((await request(app).get(`/piece-technique-versions/${VERSION_ID}/gammes`)).status).toBe(200)
    expect(
      (await request(app).post(`/piece-technique-versions/${VERSION_ID}/gammes`).send({ nom: "Gamme principale" })).status
    ).toBe(201)
    expect((await request(app).patch(`/gammes/${GAMME_ID}`).send({ commentaire: "Mise à jour" })).status).toBe(200)
    expect((await request(app).get(`/gammes/${GAMME_ID}/operations`)).status).toBe(200)
    expect((await request(app).post(`/gammes/${GAMME_ID}/operations`).send({ designation: "Tournage" })).status).toBe(201)
    expect(
      (await request(app).patch(`/gammes/${GAMME_ID}/operations/reorder`).send({ order: [OPERATION_ID] })).status
    ).toBe(200)

    expect(mocks.listGammesByVersion).toHaveBeenCalledWith(VERSION_ID)
    expect(mocks.createGamme).toHaveBeenCalledWith(
      VERSION_ID,
      expect.objectContaining({ nom: "Gamme principale", statut: "BROUILLON", is_current: false }),
      expect.objectContaining({ user_id: 1 })
    )
    expect(mocks.updateGamme).toHaveBeenCalledWith(
      GAMME_ID,
      expect.objectContaining({ commentaire: "Mise à jour" }),
      expect.objectContaining({ user_id: 1 })
    )
    expect(mocks.listGammeOperations).toHaveBeenCalledWith(GAMME_ID)
    expect(mocks.addGammeOperation).toHaveBeenCalledWith(
      GAMME_ID,
      expect.objectContaining({ designation: "Tournage" }),
      expect.objectContaining({ user_id: 1 })
    )
    expect(mocks.reorderGammeOperations).toHaveBeenCalledWith(
      GAMME_ID,
      [OPERATION_ID],
      expect.objectContaining({ user_id: 1 })
    )
  })

  it("préserve les cinq appels nominaux version", async () => {
    expect((await request(app).get(`/pieces-techniques/${PIECE_ID}/versions`)).status).toBe(200)
    expect((await request(app).post(`/pieces-techniques/${PIECE_ID}/versions`).send({ indice: "A" })).status).toBe(201)
    expect(
      (await request(app).patch(`/pieces-techniques/${PIECE_ID}/versions/${VERSION_ID}`).send({ commentaire_revision: "R1" })).status
    ).toBe(200)
    expect(
      (await request(app).patch(`/pieces-techniques/${PIECE_ID}/versions/${VERSION_ID}/status`).send({ next_statut: "EN_VALIDATION" })).status
    ).toBe(200)
    expect(
      (await request(app).post(`/pieces-techniques/${PIECE_ID}/versions/${VERSION_ID}/create-next`).send({ indice: "B" })).status
    ).toBe(201)

    expect(mocks.listVersions).toHaveBeenCalledWith(PIECE_ID)
    expect(mocks.createVersion).toHaveBeenCalledWith(
      PIECE_ID,
      expect.objectContaining({ indice: "A" }),
      expect.objectContaining({ user_id: 1 })
    )
    expect(mocks.updateVersion).toHaveBeenCalledWith(
      PIECE_ID,
      VERSION_ID,
      expect.objectContaining({ commentaire_revision: "R1" }),
      expect.objectContaining({ user_id: 1 })
    )
    expect(mocks.updateVersionStatus).toHaveBeenCalledWith(
      PIECE_ID,
      VERSION_ID,
      expect.objectContaining({ next_statut: "EN_VALIDATION" }),
      expect.objectContaining({ user_id: 1 })
    )
    expect(mocks.createNextVersion).toHaveBeenCalledWith(
      PIECE_ID,
      VERSION_ID,
      expect.objectContaining({ indice: "B" }),
      expect.objectContaining({ user_id: 1 })
    )
  })

  it("conserve les 404 métier des mises à jour introuvables", async () => {
    mocks.updateGamme.mockResolvedValueOnce(null)
    mocks.updateVersion.mockResolvedValueOnce(null)

    const gamme = await request(app).patch(`/gammes/${GAMME_ID}`).send({ commentaire: "Absent" })
    const version = await request(app)
      .patch(`/pieces-techniques/${PIECE_ID}/versions/${VERSION_ID}`)
      .send({ commentaire_revision: "Absent" })

    expect(gamme.status).toBe(404)
    expect(gamme.body).toMatchObject({ code: "NOT_FOUND", message: "Gamme introuvable" })
    expect(version.status).toBe(404)
    expect(version.body).toMatchObject({ code: "NOT_FOUND", message: "Version introuvable" })
  })
})
