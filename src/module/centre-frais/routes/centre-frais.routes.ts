// src/module/pieces-families/routes/pieces-families.routes.ts
import { Router } from "express"
import {
  createPieceCF,
  deletePieceCF,
  getPieceCF,
  listPieceCF,
  updatePieceCF,
} from "../controllers/centre-frais.controller"

import {
  createPieceCFSchema,
  idParamSchema,
  validate,
} from "../validators/centre-frais.validators"

const router = Router()

router.post("/", validate(createPieceCFSchema), createPieceCF)
router.get("/", listPieceCF)
router.get("/:id", validate(idParamSchema), getPieceCF)
router.patch("/:id", validate(idParamSchema), updatePieceCF)
router.delete("/:id", validate(idParamSchema), deletePieceCF)

export default router
