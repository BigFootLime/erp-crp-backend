import { Router, type RequestHandler } from "express"
import { requestHasGrantedAccountModuleAccess } from "../../access-control/context/account-module-access.context";

import { authenticateToken } from "../../auth/middlewares/auth.middleware"
import { createSecureUpload } from "../../../shared/uploads/secure-upload"
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
  createLivraisonFromReservations,
  correctPreparationStock,
  createLivraisonProof,
  deleteLivraisonDocument,
  deleteLivraisonLine,
  deleteLivraisonLineAllocation,
  generateLivraisonPdf,
  getLivraison,
  getLivraisonPrintStatus,
  getLivraisonPdfAvailability,
  getLivraisonShipmentPreview,
  getLivraisonPreparation,
  getLivraisonDocumentFile,
  getLivraisonPdf,
  listLivraisons,
  listPreparationCart,
  retryLivraisonPrint,
  shipLivraison,
  confirmLivraisonPreparation,
  resetLivraisonPreparation,
  updateLivraison,
  updateLivraisonLine,
  updateLivraisonStatus,
  getLivraisonCreationSnapshot, previewLivraisonCreationSnapshot, downloadLivraisonCreationSnapshot, printLivraisonCreationSnapshot,
  getShippedLivraisonOfficialDocument, previewShippedLivraisonOfficialDocument, downloadShippedLivraisonOfficialDocument, printShippedLivraisonOfficialDocument,
  uploadLivraisonDocuments,
  verifyPreparationLot,
  
} from "../controllers/livraisons.controller"

import {
  downloadLivraisonPackDocument,
  freezeLivraisonQualityDossier,
  generateLivraisonPack,
  getLivraisonPackPreview,
  getLivraisonQualityDossier,
  revokeLivraisonPackVersion,
  revokeLivraisonQualityDossier,
} from "../controllers/pack.controller"

const upload = createSecureUpload("business-document")

const router = Router()

router.use(authenticateToken)

const requireLivraisonCapability = (capability: LivraisonCapability): RequestHandler =>
  (req, _res, next) => {
    if (
      !requestHasGrantedAccountModuleAccess(req) &&
      !roleHasLivraisonCapability(req.user?.role, capability)
    ) {
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

// A physical-stock correction is intentionally narrower than ordinary BL
// preparation and stays behind the existing allocation capability.
const requireStockCorrectionPermission = requireLivraisonCapability("allocate")

router.get("/", requireLivraisonCapability("read"), listLivraisons)
router.post("/", requireLivraisonCapability("prepare"), createLivraison)
router.post(
  "/from-commande/:commandeId",
  requireLivraisonCapability("prepare"),
  createLivraisonFromCommande
)
router.get(
  "/preparation-cart",
  requireLivraisonCapability("read"),
  listPreparationCart
)
router.post(
  "/preparation-cart/verify-lot",
  requireLivraisonCapability("prepare"),
  verifyPreparationLot
)
router.post(
  "/preparation-cart/correct",
  requireStockCorrectionPermission,
  correctPreparationStock
)
router.post(
  "/from-reservations",
  requireLivraisonCapability("prepare"),
  createLivraisonFromReservations
)

router.get("/:id", requireLivraisonCapability("read"), getLivraison)
router.get("/:id/print-status", requireLivraisonCapability("read"), getLivraisonPrintStatus)
router.post("/:id/print/retry", requireLivraisonCapability("documents_manage"), retryLivraisonPrint)
router.get("/:id/creation-snapshot", requireLivraisonCapability("read"), getLivraisonCreationSnapshot)
router.get("/:id/creation-snapshot/:documentId/preview", requireLivraisonCapability("read"), previewLivraisonCreationSnapshot)
router.get("/:id/creation-snapshot/:documentId/download", requireLivraisonCapability("read"), downloadLivraisonCreationSnapshot)
router.post("/:id/creation-snapshot/:documentId/print-intents", requireLivraisonCapability("read"), printLivraisonCreationSnapshot)
router.get("/:id/official-documents/shipped", requireLivraisonCapability("export"), getShippedLivraisonOfficialDocument)
router.get("/:id/official-documents/shipped/:documentId/preview", requireLivraisonCapability("export"), previewShippedLivraisonOfficialDocument)
router.get("/:id/official-documents/shipped/:documentId/download", requireLivraisonCapability("export"), downloadShippedLivraisonOfficialDocument)
router.post("/:id/official-documents/shipped/:documentId/print-intents", requireLivraisonCapability("export"), printShippedLivraisonOfficialDocument)
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
  "/:id/preparation",
  requireLivraisonCapability("read"),
  getLivraisonPreparation
)
router.post(
  "/:id/preparation/allocations/:allocationId/confirm",
  requireLivraisonCapability("prepare"),
  confirmLivraisonPreparation
)
router.post(
  "/:id/preparation/allocations/:allocationId/reset",
  requireLivraisonCapability("prepare"),
  resetLivraisonPreparation
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

router.get(
  "/:id/pdf/availability",
  requireLivraisonCapability("read"),
  getLivraisonPdfAvailability
)
router.get("/:id/pdf", requireLivraisonCapability("read"), getLivraisonPdf)
router.post(
  "/:id/pdf",
  requireLivraisonCapability("documents_manage"),
  generateLivraisonPdf
)

router.get(
  "/:id/quality-dossier",
  requireLivraisonCapability("read"),
  getLivraisonQualityDossier
)
router.post(
  "/:id/quality-dossier/freeze",
  requireLivraisonCapability("documents_manage"),
  freezeLivraisonQualityDossier
)
router.post(
  "/:id/quality-dossier/revoke/:versionId",
  requireLivraisonCapability("documents_manage"),
  revokeLivraisonQualityDossier
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
