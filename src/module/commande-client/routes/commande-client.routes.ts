import type { RequestHandler } from "express"
import { Router } from "express"

import { authenticateToken } from "../../auth/middlewares/auth.middleware"
import { effectiveRoleHasAny } from "../../auth/domain/roles"
import { requestHasGrantedAccountModuleAccess } from "../../access-control/context/account-module-access.context"
import { HttpError } from "../../../utils/httpError"
import { createSecureUpload } from "../../../shared/uploads/secure-upload"
import {
  addCadreReleaseLine,
  analyzeCommandeStock,
  createCommande,
  createQuickTechnicalPiece,
  createCadreRelease,
  cancelCadreRelease,
  deleteCommande,
  duplicateCommande,
  downloadCommandeCreationSnapshot,
  generateAffairesFromOrder,
  previewAffairesFromCommande,
  getCadreRelease,
  getCommande,
  getCommandeStockReceipts,
  getCommandeCreationSnapshot,
  getCommandeDocumentFile,
  getCommandeWorkflow,
  listCadreReleases,
  listCommandes,
  deleteCadreReleaseLine,
  runCommandeWorkflowAction,
  updateCadreRelease,
  updateCadreReleaseLine,
  updateCadreReleaseStatus,
  updateCommande,
  updateCommandeWorkflowCheckpoint,
  previewCommandeCreationSnapshot,
  printCommandeCreationSnapshot,
} from "../controllers/commande-client.controller"
import { createAcknowledgement, downloadAcknowledgement, generateCommandeAr, getAcknowledgement, listAcknowledgements, listCommandeArVersions, previewAcknowledgement, printAcknowledgement, sendAcknowledgement, sendCommandeAr } from "../controllers/commande-ar.controller"
import {
  generateCommandeArSchema,
  sendCommandeArSchema,
} from "../validators/commande-ar.validators"
import {
  createCommandeBodySchema,
  generateAffairesV3Schema,
  commandeWorkflowCheckpointCodeParamSchema,
  documentIdParamSchema,
  idParamSchema,
  releaseIdParamSchema,
  releaseLineIdParamSchema,
  validate,
} from "../validators/commande-client.validators"

const upload = createSecureUpload("business-document")

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

const requireAcknowledgementExport: RequestHandler = (req, _res, next) => {
  if (
    requestHasGrantedAccountModuleAccess(req) ||
    effectiveRoleHasAny(req.user?.role, [
      "Administrateur Systeme et Reseau", "Directeur", "Secretaire", "Commercial", "Comptabilite",
      "Method", "Responsable Programmation", "Production", "Responsable Production", "Planification",
    ])
  ) { next(); return }
  next(new HttpError(403, "FORBIDDEN", "Votre rôle ne permet pas d'exporter les accusés de réception."))
}

const rejectLegacyCommandeLaunch: RequestHandler = (_req, _res, next) => {
  next(
    new HttpError(
      410,
      "LEGACY_COMMAND_LAUNCH_REMOVED",
      "Cet ancien lancement de commande est désactivé. Utilisez Vérifier le stock et lancer."
    )
  )
}

const rejectDirectCommandeStatusMutation: RequestHandler = (_req, _res, next) => {
  next(
    new HttpError(
      410,
      "DIRECT_COMMAND_STATUS_MUTATION_DISABLED",
      "La modification directe du statut est désactivée. Utilisez l'action du checkpoint métier actif."
    )
  )
}

// POST /api/v1/commandes  (multipart: data + documents[])
router.post("/", upload.array("documents[]"), parseCommandeBody, createCommande)

// Création commerciale courte : PT + R01 brouillon + article dans une transaction.
router.post("/technical-pieces/quick", authenticateToken, createQuickTechnicalPiece)

// GET /api/v1/commandes
router.get("/", listCommandes)

// GET /api/v1/commandes/:id
router.get("/:id", validate(idParamSchema), getCommande)

// Automatic creation snapshots are immutable GED artifacts. They deliberately
// expose no issue/reissue endpoint and retain the acknowledgement export gate.
router.get("/:id/creation-snapshot", authenticateToken, requireAcknowledgementExport, validate(idParamSchema), getCommandeCreationSnapshot)
router.get("/:id/creation-snapshot/:documentId/preview", authenticateToken, requireAcknowledgementExport, validate(idParamSchema), previewCommandeCreationSnapshot)
router.get("/:id/creation-snapshot/:documentId/download", authenticateToken, requireAcknowledgementExport, validate(idParamSchema), downloadCommandeCreationSnapshot)
router.post("/:id/creation-snapshot/:documentId/print-intents", authenticateToken, requireAcknowledgementExport, validate(idParamSchema), printCommandeCreationSnapshot)

// GET /api/v1/commandes/:id/workflow
router.get("/:id/workflow", authenticateToken, validate(idParamSchema), getCommandeWorkflow)

// GET /api/v1/commandes/:id/stock-receipts
router.get("/:id/stock-receipts", authenticateToken, validate(idParamSchema), getCommandeStockReceipts)

// PATCH /api/v1/commandes/:id/workflow/checkpoints/:checkpointCode
router.patch(
  "/:id/workflow/checkpoints/:checkpointCode",
  authenticateToken,
  validate(commandeWorkflowCheckpointCodeParamSchema),
  updateCommandeWorkflowCheckpoint
)

// POST /api/v1/commandes/:id/workflow/actions
router.post("/:id/workflow/actions", authenticateToken, validate(idParamSchema), runCommandeWorkflowAction)

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
router.post("/:id/status", authenticateToken, validate(idParamSchema), rejectDirectCommandeStatusMutation)

// POST /api/v1/commandes/:id/ar/generate
router.post(
  "/:id/ar/generate",
  authenticateToken,
  validate(generateCommandeArSchema),
  generateCommandeAr
)

router.get("/:id/ar", authenticateToken, validate(generateCommandeArSchema), listCommandeArVersions)

// Authoritative acknowledgement collection. Legacy `/ar/*` remains compatible;
// these endpoints expose GED-backed immutable documents only.
router.get("/:id/acknowledgements", authenticateToken, requireAcknowledgementExport, listAcknowledgements)
router.post("/:id/acknowledgements", authenticateToken, requireAcknowledgementExport, createAcknowledgement)
router.get("/:id/acknowledgements/:documentId", authenticateToken, requireAcknowledgementExport, getAcknowledgement)
router.get("/:id/acknowledgements/:documentId/preview", authenticateToken, requireAcknowledgementExport, previewAcknowledgement)
router.get("/:id/acknowledgements/:documentId/download", authenticateToken, requireAcknowledgementExport, downloadAcknowledgement)
router.post("/:id/acknowledgements/:documentId/print-intents", authenticateToken, requireAcknowledgementExport, printAcknowledgement)
router.post("/:id/acknowledgements/:documentId/send", authenticateToken, requireAcknowledgementExport, sendAcknowledgement)

// POST /api/v1/commandes/:id/ar/send
router.post(
  "/:id/ar/send",
  authenticateToken,
  validate(sendCommandeArSchema),
  sendCommandeAr
)

// POST /api/v1/commandes/:id/analyze-stock
router.post("/:id/analyze-stock", authenticateToken, validate(idParamSchema), analyzeCommandeStock)

// POST /api/v1/commandes/:id/generate-affaires
router.post("/:id/generate-affaires", authenticateToken, validate(generateAffairesV3Schema), generateAffairesFromOrder)

// POST /api/v1/commandes/:id/generate-affaires/confirm
router.post("/:id/generate-affaires/confirm", authenticateToken, rejectLegacyCommandeLaunch)

// POST /api/v1/commandes/:id/affaires/preview
router.post("/:id/affaires/preview", authenticateToken, validate(idParamSchema), previewAffairesFromCommande)

// POST /api/v1/commandes/:id/affaires/generate
router.post("/:id/affaires/generate", authenticateToken, rejectLegacyCommandeLaunch)

// POST /api/v1/commandes/:id/duplicate
router.post("/:id/duplicate", validate(idParamSchema), duplicateCommande)

export default router
