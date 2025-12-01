// src/module/pieces-families/routes/pieces-families.routes.ts
import { Router } from "express"
import {
  createPieceFamily,
  deletePieceFamily,
  getPieceFamily,
  listPieceFamilies,
  updatePieceFamily,
} from "../controllers/pieces-families.controller"

import {
  createPieceFamilySchema,
  idParamSchema,
  validate,
} from "../validators/pieces-families.validators"

const router = Router()

router.post("/", validate(createPieceFamilySchema), createPieceFamily)
router.get("/", listPieceFamilies)
router.get("/:id", validate(idParamSchema), getPieceFamily)
router.patch("/:id", validate(idParamSchema), updatePieceFamily)
router.delete("/:id", validate(idParamSchema), deletePieceFamily)

export default router
