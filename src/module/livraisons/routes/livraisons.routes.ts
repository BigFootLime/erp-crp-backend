import { Router, type RequestHandler } from "express"
import multer from "multer"

import { authenticateToken } from "../../auth/middlewares/auth.middleware"
import { ensureTmpStoragePath } from "../../../utils/cerpStorage"
import { HttpError } from "../../../utils/httpError"
import {
  roleHasLivraisonCapability,
  type LivraisonCapability,
} from "../domain/livraisons-rbac"
import {
  addLivraisonLine,
  addLivraisonLineAllocation,
  createLivraison,
  createLivraisonFromCommande,
  createLivraisonProof,
  deleteLivraisonDocument,
  deleteLivraisonLine,
  deleteLivraisonLineAllocation,
  generateLivraisonPdf,
  getLivraison,
  getLivraisonShipmentPreview,
  getLivraisonDocumentFile,
  getLivraisonPdf,
  listLivraisons,
  shipLivraison,
  updateLivraison,
  updateLivraisonLine,
  updateLivraisonStatus,
  uploadLivraisonDocuments,
  
} from "../controllers/livraisons.controller"

import {
  downloadLivraisonPackDocument,
  generateLivraisonPack,
  getLivraisonPackPreview,
  revokeLivraisonPackVersion,
} from "../controllers/pack.controller"

const uploadTmpDir = ensureTmpStoragePath("livraisons")
const upload = multer({
  dest: uploadTmpDir,
  limits: {
    files: 10,
    fileSize: 20 * 1024 * 1024,
    fields: 10,
  },
})

const router = Router()

router.use(authenticateToken)

const requireLivraisonCapability = (capability: LivraisonCapability): RequestHandler =>
  (req, _res, next) => {
    if (!roleHasLivraisonCapability(req.user?.role, capability)) {
      next(
        new HttpError(
          403,
          "LIVRAISON_FORBIDDEN",
          `Livraison capability required: ${capability}`
        )
      )
      return
    }
    next()
  }

const requireStatusCapability: RequestHandler = (req, _res, next) => {
  const status =
    typeof req.body === "object" && req.body !== null && "statut" in req.body
      ? String((req.body as { statut?: unknown }).statut ?? "")
      : ""
  const capability: LivraisonCapability =
    status === "CANCELLED"
      ? "cancel"
      : status === "DELIVERED"
        ? "deliver"
        : status === "SHIPPED"
          ? "ship"
          : "prepare"
  requireLivraisonCapability(capability)(req, _res, next)
}

router.get("/", requireLivraisonCapability("read"), listLivraisons)
router.post("/", requireLivraisonCapability("prepare"), createLivraison)
router.post(
  "/from-commande/:commandeId",
  requireLivraisonCapability("prepare"),
  createLivraisonFromCommande
)

router.get("/:id", requireLivraisonCapability("read"), getLivraison)
router.put("/:id", requireLivraisonCapability("prepare"), updateLivraison)

router.post("/:id/lines", requireLivraisonCapability("prepare"), addLivraisonLine)
router.put("/:id/lines/:lineId", requireLivraisonCapability("prepare"), updateLivraisonLine)
router.delete("/:id/lines/:lineId", requireLivraisonCapability("prepare"), deleteLivraisonLine)

router.post(
  "/:id/lignes/:lineId/allocations",
  requireLivraisonCapability("allocate"),
  addLivraisonLineAllocation
)
router.delete(
  "/:id/lignes/:lineId/allocations/:allocationId",
  requireLivraisonCapability("allocate"),
  deleteLivraisonLineAllocation
)

router.get(
  "/:id/shipment-preview",
  requireLivraisonCapability("ship"),
  getLivraisonShipmentPreview
)
router.post("/:id/ship", requireLivraisonCapability("ship"), shipLivraison)
router.post("/:id/status", requireStatusCapability, updateLivraisonStatus)
router.post("/:id/proofs", requireLivraisonCapability("proof_manage"), createLivraisonProof)

router.post(
  "/:id/documents",
  requireLivraisonCapability("documents_manage"),
  upload.array("documents[]"),
  uploadLivraisonDocuments
)
router.delete(
  "/:id/documents/:docId",
  requireLivraisonCapability("documents_manage"),
  deleteLivraisonDocument
)
router.get(
  "/:id/documents/:docId/file",
  requireLivraisonCapability("read"),
  getLivraisonDocumentFile
)

router.get("/:id/pdf", requireLivraisonCapability("read"), getLivraisonPdf)
router.post(
  "/:id/pdf",
  requireLivraisonCapability("documents_manage"),
  generateLivraisonPdf
)

router.get(
  "/:id/pack/preview",
  requireLivraisonCapability("read"),
  getLivraisonPackPreview
)
router.post(
  "/:id/pack/generate",
  requireLivraisonCapability("documents_manage"),
  generateLivraisonPack
)
router.get(
  "/:id/pack/download/:documentId",
  requireLivraisonCapability("read"),
  downloadLivraisonPackDocument
)
router.post(
  "/:id/pack/revoke/:versionId",
  requireLivraisonCapability("documents_manage"),
  revokeLivraisonPackVersion
)

export default router
