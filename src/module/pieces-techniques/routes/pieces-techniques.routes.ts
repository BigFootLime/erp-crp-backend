// src/module/pieces-techniques/routes/pieces-techniques.routes.ts
import { Router, type RequestHandler } from "express"
import { requestHasGrantedAccountModuleAccess } from "../../access-control/context/account-module-access.context";

import { authenticateToken, authorizeRole } from "../../auth/middlewares/auth.middleware"
import { createSecureUpload } from "../../../shared/uploads/secure-upload"
import { HttpError } from "../../../utils/httpError"
import {
  canValidatePieceTechnique,
  PIECE_DOCUMENT_POLICY_ROLES,
  PIECE_TECHNIQUE_DELETE_ROLES,
} from "../pieces-techniques.permissions"
import {
  abandonPieceDraft,
  createDocumentType,
  createPieceDraft,
  downloadPieceDocumentDossierPdf,
  getClientDocumentPolicy,
  getPieceDocumentDossier,
  getPieceDraft,
  getPieceTechniquePermissions,
  listDocumentTypes,
  listPieceDrafts,
  listVersionFrozenRequirements,
  setClientDocumentPolicy,
  setPieceCritique,
  updateDocumentType,
  updatePieceDraft,
} from "../controllers/document-policy.controller"
import {
  clientIdParamSchema,
  createDocumentTypeSchema,
  documentTypeCodeParamSchema,
  draftIdParamSchema,
  saveDraftSchema,
  setClientDocumentPolicySchema,
  setPieceCritiqueSchema,
  updateDocumentTypeSchema,
  versionIdOnlyParamSchema,
} from "../validators/document-policy.validators"
import {
  addAchat,
  addBomLine,
  addOperation,
  createPieceTechnique,
  previewPieceTechniqueCode,
  deletePieceTechnique,
  deleteAchat,
  deleteBomLine,
  deleteOperation,
  duplicatePieceTechnique,
  downloadPieceTechniqueDocument,
  getPieceTechniqueFabricationTree,
  getPieceTechnique,
  linkPieceTechniqueAffaire,
  listAffairePieceTechniques,
  listPieceTechniqueAffaires,
  listPieceTechniques,
  getPieceTechniquesSummary,
  listPieceTechniqueDocuments,
  attachPieceTechniqueDocuments,
  unlinkPieceTechniqueAffaire,
  reorderAchats,
  reorderBom,
  reorderOperations,
  removePieceTechniqueDocument,
  updateAchat,
  updateBomLine,
  updateOperation,
  updatePieceTechnique,
  updatePieceTechniqueStatus,
} from "../controllers/pieces-techniques.controller"

import {
  achatIdParamSchema,
  addAchatSchema,
  addBomLineSchema,
  addOperationSchema,
  affaireIdParamSchema,
  affaireOnlyParamSchema,
  bomLineIdParamSchema,
  createPieceTechniqueSchema,
  documentIdParamSchema,
  idParamSchema,
  linkAffaireSchema,
  operationIdParamSchema,
  pieceTechniqueStatusSchema,
  reorderSchema,
  updateAchatSchema,
  updateBomLineSchema,
  updateOperationSchema,
  updatePieceTechniqueSchema,
  validate,
} from "../validators/pieces-techniques.validators"

import {
  createNextVersion,
  createVersion,
  listVersions,
  updateVersion,
  updateVersionStatus,
  publishVersion,
} from "../controllers/versions.controller"
import { createOrLinkArticleFabrique, getPieceArticlePrincipal } from "../controllers/piece-article.controller"
import {
  createNextVersionSchema,
  createVersionSchema,
  updateVersionSchema,
  versionIdParamSchema,
  versionStatusSchema,
  publishVersionSchema,
} from "../validators/versions.validators"
import {
  getTechnicalCompleteness,
  listToolRequirements,
  replaceToolRequirements,
  requireOutillageCapability,
} from "../../outils/controllers/outillage-lifecycle.controller"

const router = Router()

// #227 — RBAC explicite. L'ancien garde testait `role.includes("admin")` : il refusait le
// Directeur, le Responsable Qualité et le Responsable Programmation (le fameux « accès
// refusé » à la validation d'un indice), acceptait tout futur rôle contenant « admin »,
// et ignorait le multi-rôles #315. Les listes vivent dans pieces-techniques.permissions.ts
// et sont comparées aux rôles réellement assignés.
const requireDeleteRole = authorizeRole(...PIECE_TECHNIQUE_DELETE_ROLES)
const requireDocumentPolicyRole = authorizeRole(...PIECE_DOCUMENT_POLICY_ROLES)
const requireVersionApproval: RequestHandler = (req, _res, next) => {
  if (
    !requestHasGrantedAccountModuleAccess(req) &&
    !canValidatePieceTechnique(req.user)
  ) {
    next(
      new HttpError(
        403,
        "PIECE_VERSION_APPROVAL_FORBIDDEN",
        "Technical definition approval role required"
      )
    )
    return
  }
  next()
}

const upload = createSecureUpload("technical-document")

router.use(authenticateToken)

router.get("/code-preview", previewPieceTechniqueCode)
router.post("/", validate(createPieceTechniqueSchema), createPieceTechnique)
// #146 — Déclarée AVANT `/:id`, sinon Express interpréterait « summary » comme un
// identifiant de pièce et renverrait un 400 de validation UUID.
router.get("/summary", getPieceTechniquesSummary)

// #227 — Toutes ces routes littérales DOIVENT rester au-dessus de `/:id`.
router.get("/permissions", getPieceTechniquePermissions)
router.get("/document-types", listDocumentTypes)
router.post("/document-types", requireDocumentPolicyRole, validate(createDocumentTypeSchema), createDocumentType)
router.patch(
  "/document-types/:code",
  requireDocumentPolicyRole,
  validate(documentTypeCodeParamSchema),
  validate(updateDocumentTypeSchema),
  updateDocumentType
)
router.get("/document-policy/:clientId", validate(clientIdParamSchema), getClientDocumentPolicy)
router.put(
  "/document-policy/:clientId",
  requireDocumentPolicyRole,
  validate(clientIdParamSchema),
  validate(setClientDocumentPolicySchema),
  setClientDocumentPolicy
)
router.get("/drafts", listPieceDrafts)
router.post("/drafts", validate(saveDraftSchema), createPieceDraft)
router.get("/drafts/:draftId", validate(draftIdParamSchema), getPieceDraft)
router.put("/drafts/:draftId", validate(draftIdParamSchema), validate(saveDraftSchema), updatePieceDraft)
router.delete("/drafts/:draftId", validate(draftIdParamSchema), abandonPieceDraft)
router.get("/versions/:versionId/document-requirements", validate(versionIdOnlyParamSchema), listVersionFrozenRequirements)

router.get("/", listPieceTechniques)
router.get("/by-affaire/:affaireId", validate(affaireOnlyParamSchema), listAffairePieceTechniques)
router.get("/:id/arborescence", validate(idParamSchema), getPieceTechniqueFabricationTree)
router.get("/:id/document-dossier", validate(idParamSchema), getPieceDocumentDossier)
router.get("/:id/document-dossier/pdf", validate(idParamSchema), downloadPieceDocumentDossierPdf)
router.post("/:id/piece-critique", validate(idParamSchema), validate(setPieceCritiqueSchema), setPieceCritique)
router.get("/:id", validate(idParamSchema), getPieceTechnique)
router.patch("/:id", validate(idParamSchema), validate(updatePieceTechniqueSchema), updatePieceTechnique)
router.delete("/:id", requireDeleteRole, validate(idParamSchema), deletePieceTechnique)

router.post("/:id/duplicate", validate(idParamSchema), duplicatePieceTechnique)
router.post("/:id/status", validate(idParamSchema), validate(pieceTechniqueStatusSchema), updatePieceTechniqueStatus)

// GPAO B5 — article fabriqué principal lié à la pièce
router.get("/:id/article-principal", validate(idParamSchema), getPieceArticlePrincipal)
router.post("/:id/create-or-link-article-fabrique", validate(idParamSchema), createOrLinkArticleFabrique)

// Versions / indices (GPAO B2.1) — source de vérité indice/plan/statut.
router.get("/:id/versions", validate(idParamSchema), listVersions)
router.post("/:id/versions", validate(idParamSchema), validate(createVersionSchema), createVersion)
router.patch("/:id/versions/:versionId", validate(versionIdParamSchema), validate(updateVersionSchema), updateVersion)
router.patch("/:id/versions/:versionId/status", requireVersionApproval, validate(versionIdParamSchema), validate(versionStatusSchema), updateVersionStatus)
router.post("/:id/versions/:versionId/publish", requireVersionApproval, validate(versionIdParamSchema), validate(publishVersionSchema), publishVersion)
router.post("/:id/versions/:versionId/create-next", validate(versionIdParamSchema), validate(createNextVersionSchema), createNextVersion)
router.get(
  "/:id/versions/:versionId/completeness",
  requireOutillageCapability("read"),
  getTechnicalCompleteness
)
router.put(
  "/:id/versions/:versionId/tool-requirements",
  requireOutillageCapability("configure"),
  replaceToolRequirements
)
router.get(
  "/:id/versions/:versionId/tool-requirements",
  requireOutillageCapability("read"),
  listToolRequirements
)

router.post("/:id/nomenclature", validate(idParamSchema), validate(addBomLineSchema), addBomLine)
router.patch("/:id/nomenclature/:lineId", validate(bomLineIdParamSchema), validate(updateBomLineSchema), updateBomLine)
router.delete("/:id/nomenclature/:lineId", validate(bomLineIdParamSchema), deleteBomLine)
router.post("/:id/nomenclature/reorder", validate(idParamSchema), validate(reorderSchema), reorderBom)

router.post("/:id/operations", validate(idParamSchema), validate(addOperationSchema), addOperation)
router.patch("/:id/operations/:opId", validate(operationIdParamSchema), validate(updateOperationSchema), updateOperation)
router.delete("/:id/operations/:opId", validate(operationIdParamSchema), deleteOperation)
router.post("/:id/operations/reorder", validate(idParamSchema), validate(reorderSchema), reorderOperations)

router.post("/:id/achats", validate(idParamSchema), validate(addAchatSchema), addAchat)
router.patch("/:id/achats/:achatId", validate(achatIdParamSchema), validate(updateAchatSchema), updateAchat)
router.delete("/:id/achats/:achatId", validate(achatIdParamSchema), deleteAchat)
router.post("/:id/achats/reorder", validate(idParamSchema), validate(reorderSchema), reorderAchats)

router.get("/:id/affaires", validate(idParamSchema), listPieceTechniqueAffaires)
router.post("/:id/affaires", validate(idParamSchema), validate(linkAffaireSchema), linkPieceTechniqueAffaire)
router.delete("/:id/affaires/:affaireId", validate(affaireIdParamSchema), unlinkPieceTechniqueAffaire)

router.get("/:id/documents", validate(idParamSchema), listPieceTechniqueDocuments)
router.post("/:id/documents", validate(idParamSchema), upload.array("documents[]"), attachPieceTechniqueDocuments)
router.delete("/:id/documents/:docId", validate(documentIdParamSchema), removePieceTechniqueDocument)
router.get("/:id/documents/:docId/file", validate(documentIdParamSchema), downloadPieceTechniqueDocument)

export default router
