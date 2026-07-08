// src/module/pieces-techniques/routes/pieces-techniques.routes.ts
import { Router, type RequestHandler } from "express"
import multer from "multer"

import { authenticateToken } from "../../auth/middlewares/auth.middleware"
import { ensureDocumentStoragePath } from "../../../utils/cerpStorage"
import { HttpError } from "../../../utils/httpError"
import {
  addAchat,
  addBomLine,
  addOperation,
  createPieceTechnique,
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
} from "../controllers/versions.controller"
import { createOrLinkArticleFabrique, getPieceArticlePrincipal } from "../controllers/piece-article.controller"
import {
  createNextVersionSchema,
  createVersionSchema,
  updateVersionSchema,
  versionIdParamSchema,
  versionStatusSchema,
} from "../validators/versions.validators"

const router = Router()

function isAdminRole(role: string | undefined): boolean {
  if (!role) return false
  const r = role.trim().toLowerCase()
  return r.includes("admin") || r.includes("administrateur")
}

const requireAdmin: RequestHandler = (req, _res, next) => {
  if (!isAdminRole(req.user?.role)) {
    next(new HttpError(403, "FORBIDDEN", "Admin role required"))
    return
  }
  next()
}

const docsBaseDir = ensureDocumentStoragePath("pieces-techniques")

const upload = multer({
  dest: docsBaseDir,
  limits: {
    fileSize: 25 * 1024 * 1024,
  },
})

router.use(authenticateToken)

router.post("/", validate(createPieceTechniqueSchema), createPieceTechnique)
router.get("/", listPieceTechniques)
router.get("/by-affaire/:affaireId", validate(affaireOnlyParamSchema), listAffairePieceTechniques)
router.get("/:id/arborescence", validate(idParamSchema), getPieceTechniqueFabricationTree)
router.get("/:id", validate(idParamSchema), getPieceTechnique)
router.patch("/:id", validate(idParamSchema), validate(updatePieceTechniqueSchema), updatePieceTechnique)
router.delete("/:id", requireAdmin, validate(idParamSchema), deletePieceTechnique)

router.post("/:id/duplicate", validate(idParamSchema), duplicatePieceTechnique)
router.post("/:id/status", validate(idParamSchema), validate(pieceTechniqueStatusSchema), updatePieceTechniqueStatus)

// GPAO B5 — article fabriqué principal lié à la pièce
router.get("/:id/article-principal", validate(idParamSchema), getPieceArticlePrincipal)
router.post("/:id/create-or-link-article-fabrique", validate(idParamSchema), createOrLinkArticleFabrique)

// Versions / indices (GPAO B2.1) — source de vérité indice/plan/statut.
router.get("/:id/versions", validate(idParamSchema), listVersions)
router.post("/:id/versions", validate(idParamSchema), validate(createVersionSchema), createVersion)
router.patch("/:id/versions/:versionId", validate(versionIdParamSchema), validate(updateVersionSchema), updateVersion)
router.patch("/:id/versions/:versionId/status", validate(versionIdParamSchema), validate(versionStatusSchema), updateVersionStatus)
router.post("/:id/versions/:versionId/create-next", validate(versionIdParamSchema), validate(createNextVersionSchema), createNextVersion)

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
