// src/module/pieces-techniques/routes/pieces-techniques.routes.ts
import { Router } from "express"
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
  getPieceTechnique,
  listPieceTechniques,
  reorderAchats,
  reorderBom,
  reorderOperations,
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
  bomLineIdParamSchema,
  createPieceTechniqueSchema,
  idParamSchema,
  operationIdParamSchema,
  pieceTechniqueStatusSchema,
  reorderSchema,
  updateAchatSchema,
  updateBomLineSchema,
  updateOperationSchema,
  updatePieceTechniqueSchema,
  validate,
} from "../validators/pieces-techniques.validators"

const router = Router()

router.post("/", validate(createPieceTechniqueSchema), createPieceTechnique)
router.get("/", listPieceTechniques)
router.get("/:id", validate(idParamSchema), getPieceTechnique)
router.patch("/:id", validate(idParamSchema), validate(updatePieceTechniqueSchema), updatePieceTechnique)
router.delete("/:id", validate(idParamSchema), deletePieceTechnique)

router.post("/:id/duplicate", validate(idParamSchema), duplicatePieceTechnique)
router.post("/:id/status", validate(idParamSchema), validate(pieceTechniqueStatusSchema), updatePieceTechniqueStatus)

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

export default router
