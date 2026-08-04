import { Router } from "express"

import { authenticateToken } from "../../auth/middlewares/auth.middleware"
import { createSecureUpload } from "../../../shared/uploads/secure-upload"
import {
  createOperationDossierVersion,
  downloadOperationDossierDocument,
  getOperationDossierByOperation,
} from "../controllers/operation-dossiers.controller"

const upload = createSecureUpload("technical-document")

const router = Router()
router.use(authenticateToken)

// GET /api/v1/dossiers/operation?operation_type=...&operation_id=...&dossier_type=...
router.get("/operation", getOperationDossierByOperation)

// POST /api/v1/dossiers/:dossierId/versions (multipart/form-data)
router.post("/:dossierId/versions", upload.any(), createOperationDossierVersion)

// GET /api/v1/dossiers/documents/:documentId/download
router.get("/documents/:documentId/download", downloadOperationDossierDocument)

export default router
