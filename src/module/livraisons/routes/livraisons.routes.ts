import { Router } from "express"
import multer from "multer"
import fs from "node:fs"
import path from "node:path"

import { authenticateToken } from "../../auth/middlewares/auth.middleware"
import {
  addLivraisonLine,
  createLivraison,
  createLivraisonFromCommande,
  deleteLivraisonDocument,
  deleteLivraisonLine,
  generateLivraisonPdf,
  getLivraison,
  getLivraisonDocumentFile,
  getLivraisonPdf,
  listLivraisons,
  updateLivraison,
  updateLivraisonLine,
  updateLivraisonStatus,
  uploadLivraisonDocuments,
} from "../controllers/livraisons.controller"

const ensureDir = (dir: string) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

const uploadTmpDir = path.resolve("uploads/tmp")
ensureDir(uploadTmpDir)
const upload = multer({ dest: uploadTmpDir })

const router = Router()

router.use(authenticateToken)

router.get("/", listLivraisons)
router.post("/", createLivraison)
router.post("/from-commande/:commandeId", createLivraisonFromCommande)

router.get("/:id", getLivraison)
router.put("/:id", updateLivraison)

router.post("/:id/lines", addLivraisonLine)
router.put("/:id/lines/:lineId", updateLivraisonLine)
router.delete("/:id/lines/:lineId", deleteLivraisonLine)

router.post("/:id/status", updateLivraisonStatus)

router.post("/:id/documents", upload.array("documents[]"), uploadLivraisonDocuments)
router.delete("/:id/documents/:docId", deleteLivraisonDocument)
router.get("/:id/documents/:docId/file", getLivraisonDocumentFile)

router.get("/:id/pdf", getLivraisonPdf)
router.post("/:id/pdf", generateLivraisonPdf)

export default router
