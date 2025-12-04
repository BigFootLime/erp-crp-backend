// src/module/pieces-techniques/routes/pieces-techniques.routes.ts
import { Router } from "express"
import {
  createPieceTechnique,
  deletePieceTechnique,
  getPieceTechnique,
  listPieceTechniques,
  updatePieceTechnique,
} from "../controllers/pieces-techniques.controller"

import {
  createPieceTechniqueSchema,
  idParamSchema,
  validate,
} from "../validators/pieces-techniques.validators"

const router = Router()

router.post("/", validate(createPieceTechniqueSchema), createPieceTechnique)
router.get("/", listPieceTechniques)
router.get("/:id", validate(idParamSchema), getPieceTechnique)
router.patch("/:id", validate(idParamSchema), updatePieceTechnique)
router.delete("/:id", validate(idParamSchema), deletePieceTechnique)

export default router
