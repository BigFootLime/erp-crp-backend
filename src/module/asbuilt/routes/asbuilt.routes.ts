import { Router } from "express"

import { authenticateToken } from "../../auth/middlewares/auth.middleware"
import { requireTraceabilityCapability } from "../../traceability/middlewares/traceability-authorization.middleware"

import { downloadAsbuiltDocument, generateAsbuiltPack, getAsbuiltPreview } from "../controllers/asbuilt.controller"

/**
 * Dossier as-built (#142). Le routeur n'était protégé que par le JWT :
 * tout compte authentifié pouvait générer et télécharger un dossier de
 * conformité client. Il déclare désormais ses capacités fines.
 *
 * Générer et télécharger sont deux droits DISTINCTS : l'ADV doit pouvoir
 * envoyer un dossier au client sans avoir le droit de le produire.
 */
const router = Router()

router.use(authenticateToken)

router.get("/lots/:lotId/preview", requireTraceabilityCapability("read"), getAsbuiltPreview)
router.post("/lots/:lotId/generate", requireTraceabilityCapability("asbuilt_generate"), generateAsbuiltPack)
router.get(
  "/lots/:lotId/download/:documentId",
  requireTraceabilityCapability("asbuilt_download"),
  downloadAsbuiltDocument
)

export default router
