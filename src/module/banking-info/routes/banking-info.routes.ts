// src/module/banking-info/routes/banking-info.routes.ts
import { Router } from "express"
import {
  createBankingInfo,
  deleteBankingInfo,
  getBankingInfo,
  listBankingInfos,
  updateBankingInfo,
} from "../controllers/banking-info.controller"
import { createBankingInfoSchema, idParamSchema, validate } from "../validators/banking-info.validators"

const router = Router()

// POST   /api/v1/banking-info
router.post("/", validate(createBankingInfoSchema), createBankingInfo)

// GET    /api/v1/banking-info
router.get("/", listBankingInfos)

// GET    /api/v1/banking-info/:id
router.get("/:id", validate(idParamSchema), getBankingInfo)

// PATCH  /api/v1/banking-info/:id
router.patch("/:id", validate(idParamSchema), updateBankingInfo)

// DELETE /api/v1/banking-info/:id
router.delete("/:id", validate(idParamSchema), deleteBankingInfo)

export default router
