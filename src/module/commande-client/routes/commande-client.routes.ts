import type { RequestHandler } from "express"
import { Router } from "express"
import multer from "multer"
import path from "path"
import fs from "fs"
import {
  addCadreReleaseLine,
  createCommande,
  createCadreRelease,
  cancelCadreRelease,
  deleteCommande,
  duplicateCommande,
  generateAffairesFromOrder,
  confirmGenerateAffaires,
  previewAffairesFromCommande,
  generateAffairesFromCommande,
  getCadreRelease,
  getCommande,
  getCommandeDocumentFile,
  listCadreReleases,
  listCommandes,
  deleteCadreReleaseLine,
  updateCadreRelease,
  updateCadreReleaseLine,
  updateCadreReleaseStatus,
  updateCommande,
  updateCommandeStatus,
} from "../controllers/commande-client.controller"
import {
  createCommandeBodySchema,
  confirmGenerateAffairesSchema,
  generateAffairesSchema,
  documentIdParamSchema,
  idParamSchema,
  releaseIdParamSchema,
  releaseLineIdParamSchema,
  validate,
} from "../validators/commande-client.validators"

// Storage vers /uploads/docs (ou ton NAS si prod)
const ensureDir = (dir: string) => { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }) }
const uploadDir = path.resolve("uploads/docs")
ensureDir(uploadDir)
const upload = multer({ dest: uploadDir })

// middleware pour parser `data` JSON depuis multipart
declare global {
  namespace Express {
    interface Request {
      parsedCommandeBody?: unknown
    }
  }
}

const parseCommandeBody: RequestHandler = (req, res, next) => {
  try {
    const raw = req.body?.data
    if (!raw) throw new Error("payload manquant")
    const json = JSON.parse(raw)
    // validation zod ici pour renvoyer 400 tôt
    const parsed = createCommandeBodySchema.safeParse(json)
    if (!parsed.success) {
      const msg = parsed.error.issues?.[0]?.message ?? "Invalid request"
      res.status(400).json({ error: msg })
      return
    }
    req.parsedCommandeBody = parsed.data
    next()
  } catch (e) {
    const message = e instanceof Error ? e.message : "Invalid payload"
    res.status(400).json({ error: message })
  }
}

const router = Router()

// POST /api/v1/commandes  (multipart: data + documents[])
router.post("/", upload.array("documents[]"), parseCommandeBody, createCommande)

// GET /api/v1/commandes
router.get("/", listCommandes)

// GET /api/v1/commandes/:id
router.get("/:id", validate(idParamSchema), getCommande)

// GET /api/v1/commandes/:id/documents/:docId/file
router.get("/:id/documents/:docId/file", validate(documentIdParamSchema), getCommandeDocumentFile)

// CADRE releases (call-offs)
// GET /api/v1/commandes/:id/releases
router.get("/:id/releases", validate(idParamSchema), listCadreReleases)

// POST /api/v1/commandes/:id/releases
router.post("/:id/releases", validate(idParamSchema), createCadreRelease)

// GET /api/v1/commandes/:id/releases/:releaseId
router.get("/:id/releases/:releaseId", validate(releaseIdParamSchema), getCadreRelease)

// PATCH /api/v1/commandes/:id/releases/:releaseId
router.patch("/:id/releases/:releaseId", validate(releaseIdParamSchema), updateCadreRelease)

// DELETE /api/v1/commandes/:id/releases/:releaseId  (cancel)
router.delete("/:id/releases/:releaseId", validate(releaseIdParamSchema), cancelCadreRelease)

// POST /api/v1/commandes/:id/releases/:releaseId/status
router.post("/:id/releases/:releaseId/status", validate(releaseIdParamSchema), updateCadreReleaseStatus)

// POST /api/v1/commandes/:id/releases/:releaseId/lines
router.post("/:id/releases/:releaseId/lines", validate(releaseIdParamSchema), addCadreReleaseLine)

// PATCH /api/v1/commandes/:id/releases/:releaseId/lines/:lineId
router.patch(
  "/:id/releases/:releaseId/lines/:lineId",
  validate(releaseLineIdParamSchema),
  updateCadreReleaseLine
)

// DELETE /api/v1/commandes/:id/releases/:releaseId/lines/:lineId
router.delete(
  "/:id/releases/:releaseId/lines/:lineId",
  validate(releaseLineIdParamSchema),
  deleteCadreReleaseLine
)

// PATCH /api/v1/commandes/:id  (multipart: data + documents[])
router.patch("/:id", validate(idParamSchema), upload.array("documents[]"), parseCommandeBody, updateCommande)

// DELETE /api/v1/commandes/:id
router.delete("/:id", validate(idParamSchema), deleteCommande)

// POST /api/v1/commandes/:id/status
router.post("/:id/status", validate(idParamSchema), updateCommandeStatus)

// POST /api/v1/commandes/:id/generate-affaires
router.post("/:id/generate-affaires", validate(idParamSchema), generateAffairesFromOrder)

// POST /api/v1/commandes/:id/generate-affaires/confirm
router.post("/:id/generate-affaires/confirm", validate(confirmGenerateAffairesSchema), confirmGenerateAffaires)

// POST /api/v1/commandes/:id/affaires/preview
router.post("/:id/affaires/preview", validate(idParamSchema), previewAffairesFromCommande)

// POST /api/v1/commandes/:id/affaires/generate
router.post("/:id/affaires/generate", validate(generateAffairesSchema), generateAffairesFromCommande)

// POST /api/v1/commandes/:id/duplicate
router.post("/:id/duplicate", validate(idParamSchema), duplicateCommande)

export default router
