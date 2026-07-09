// src/module/gammes/routes/gammes.routes.ts — monté sur /gammes
import { Router } from "express"
import { authenticateToken } from "../../auth/middlewares/auth.middleware"
import {
  addGammeOperation,
  listGammeOperations,
  reorderGammeOperations,
  updateGamme,
} from "../controllers/gammes.controller"
import {
  addGammeOperationSchema,
  gammeIdParamSchema,
  reorderOperationsSchema,
  updateGammeSchema,
  validate,
} from "../validators/gammes.validators"

const router = Router()
router.use(authenticateToken)

router.patch("/:gammeId", validate(gammeIdParamSchema), validate(updateGammeSchema), updateGamme)
router.get("/:gammeId/operations", validate(gammeIdParamSchema), listGammeOperations)
router.post("/:gammeId/operations", validate(gammeIdParamSchema), validate(addGammeOperationSchema), addGammeOperation)
router.patch(
  "/:gammeId/operations/reorder",
  validate(gammeIdParamSchema),
  validate(reorderOperationsSchema),
  reorderGammeOperations
)

export default router
