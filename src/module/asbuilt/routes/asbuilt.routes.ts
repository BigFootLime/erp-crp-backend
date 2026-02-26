import { Router } from "express"

import { authenticateToken } from "../../auth/middlewares/auth.middleware"

import { downloadAsbuiltDocument, generateAsbuiltPack, getAsbuiltPreview } from "../controllers/asbuilt.controller"

const router = Router()

router.use(authenticateToken)

router.get("/lots/:lotId/preview", getAsbuiltPreview)
router.post("/lots/:lotId/generate", generateAsbuiltPack)
router.get("/lots/:lotId/download/:documentId", downloadAsbuiltDocument)

export default router
