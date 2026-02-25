import { Router } from "express"
import multer from "multer"
import fs from "node:fs"
import path from "node:path"

import { authenticateToken } from "../../auth/middlewares/auth.middleware"
import {
  createOperationDossierVersion,
  downloadOperationDossierDocument,
  getOperationDossierByOperation,
} from "../controllers/operation-dossiers.controller"

const ensureDir = (dir: string) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

const uploadTmpDir = path.resolve("uploads/tmp")
ensureDir(uploadTmpDir)
const upload = multer({ dest: uploadTmpDir, limits: { files: 10 } })

const router = Router()
router.use(authenticateToken)

// GET /api/v1/dossiers/operation?operation_type=...&operation_id=...&dossier_type=...
router.get("/operation", getOperationDossierByOperation)

// POST /api/v1/dossiers/:dossierId/versions (multipart/form-data)
router.post("/:dossierId/versions", upload.any(), createOperationDossierVersion)

// GET /api/v1/dossiers/documents/:documentId/download
router.get("/documents/:documentId/download", downloadOperationDossierDocument)

export default router
