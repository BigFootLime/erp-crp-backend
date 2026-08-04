import { Router } from "express"

import { authenticateToken } from "../../auth/middlewares/auth.middleware"
import { createSecureUpload } from "../../../shared/uploads/secure-upload"
import {
  addIncomingMeasurement,
  attachReceptionDocuments,
  createLotForReceptionLine,
  createReception,
  createReceptionLine,
  createReceptionStockReceipt,
  decideIncomingInspection,
  downloadReceptionDocument,
  getReception,
  getReceptionsKpis,
  listReceptions,
  patchReception,
  removeReceptionDocument,
  startIncomingInspection,
} from "../controllers/receptions.controller"

const upload = createSecureUpload("quality-document")

const router = Router()
router.use(authenticateToken)

router.get("/kpis", getReceptionsKpis)
router.get("/", listReceptions)
router.post("/", createReception)
router.get("/:id", getReception)
router.patch("/:id", patchReception)

router.post("/:id/lines", createReceptionLine)
router.post("/:id/lines/:lineId/create-lot", createLotForReceptionLine)
router.post("/:id/lines/:lineId/inspection/start", startIncomingInspection)
router.post("/:id/lines/:lineId/inspection/measurements", addIncomingMeasurement)
router.post("/:id/lines/:lineId/inspection/decide", decideIncomingInspection)
router.post("/:id/lines/:lineId/stock-receipt", createReceptionStockReceipt)

router.post("/:id/documents", upload.array("documents[]"), attachReceptionDocuments)
router.delete("/:id/documents/:docId", removeReceptionDocument)
router.get("/:id/documents/:docId/download", downloadReceptionDocument)

export default router
