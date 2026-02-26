import { Router } from "express"

import { authenticateToken } from "../../auth/middlewares/auth.middleware"

import { getTraceabilityChain } from "../controllers/traceability.controller"

const router = Router()

router.use(authenticateToken)

router.get("/chain", getTraceabilityChain)

export default router
