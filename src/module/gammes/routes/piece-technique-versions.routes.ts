// src/module/gammes/routes/piece-technique-versions.routes.ts — monté sur /piece-technique-versions
import { Router } from "express"
import { authenticateToken } from "../../auth/middlewares/auth.middleware"
import { createGamme, listGammesByVersion } from "../controllers/gammes.controller"
import { createGammeSchema, validate, versionIdParamSchema } from "../validators/gammes.validators"

const router = Router()
router.use(authenticateToken)

router.get("/:versionId/gammes", validate(versionIdParamSchema), listGammesByVersion)
router.post("/:versionId/gammes", validate(versionIdParamSchema), validate(createGammeSchema), createGamme)

export default router
