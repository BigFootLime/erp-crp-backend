import { Router } from "express"
import fs from "fs"
import multer from "multer"
import path from "path"

import { authenticateToken } from "../../auth/middlewares/auth.middleware"
import {
  attachFournisseurDocuments,
  createFournisseur,
  createFournisseurCatalogueItem,
  createFournisseurContact,
  deactivateFournisseur,
  deleteFournisseurCatalogueItem,
  deleteFournisseurContact,
  downloadFournisseurDocument,
  getFournisseur,
  listFournisseurCatalogue,
  listFournisseurContacts,
  listFournisseurDocuments,
  listFournisseurs,
  removeFournisseurDocument,
  updateFournisseur,
  updateFournisseurCatalogueItem,
  updateFournisseurContact,
} from "../controllers/fournisseurs.controller"

const ensureDir = (dir: string) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

const docsBaseDir = path.resolve("uploads/docs/fournisseurs")
ensureDir(docsBaseDir)

const upload = multer({
  dest: docsBaseDir,
  limits: { fileSize: 25 * 1024 * 1024, files: 10 },
})

const router = Router()
router.use(authenticateToken)

router.get("/", listFournisseurs)
router.post("/", createFournisseur)
router.get("/:id", getFournisseur)
router.patch("/:id", updateFournisseur)
router.post("/:id/deactivate", deactivateFournisseur)

router.get("/:id/contacts", listFournisseurContacts)
router.post("/:id/contacts", createFournisseurContact)
router.patch("/:id/contacts/:contactId", updateFournisseurContact)
router.delete("/:id/contacts/:contactId", deleteFournisseurContact)

router.get("/:id/catalogue", listFournisseurCatalogue)
router.post("/:id/catalogue", createFournisseurCatalogueItem)
router.patch("/:id/catalogue/:catalogueId", updateFournisseurCatalogueItem)
router.delete("/:id/catalogue/:catalogueId", deleteFournisseurCatalogueItem)

router.get("/:id/documents", listFournisseurDocuments)
router.post("/:id/documents", upload.array("documents[]"), attachFournisseurDocuments)
router.delete("/:id/documents/:docId", removeFournisseurDocument)
router.get("/:id/documents/:docId/download", downloadFournisseurDocument)

export default router
