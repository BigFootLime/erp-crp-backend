import { Router } from "express"
import * as processing from '../controllers/receipt-processing.controller';

import { authenticateToken } from "../../auth/middlewares/auth.middleware"
import { createSecureUpload } from "../../../shared/uploads/secure-upload"
import {expectedReceiptLines,stageGroupedReceipt,validateGroupedReceipt} from '../controllers/grouped-receipts.controller';
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
router.get('/processing', processing.listProcessing)
router.get('/:id/lines/:lineId/processing', processing.getProcessing)
router.post('/:id/lines/:lineId/pack', processing.packProcessing)
router.post('/:id/lines/:lineId/stock', processing.stockProcessing)
router.post('/:id/lines/:lineId/tool-stock', processing.toolStockProcessing)
router.post('/:id/lines/:lineId/subcontract-origins', processing.subcontractProcessing)
router.post('/:id/lines/:lineId/stock-article', processing.mapProcessing)
router.post('/:id/lines/:lineId/reconcile-processing', processing.reconcileProcessing)
router.post('/:id/lines/:lineId/void-packaging', processing.voidProcessing)
router.get('/expected-lines',expectedReceiptLines)
router.post('/grouped',stageGroupedReceipt)
router.post('/:id/confirm',validateGroupedReceipt)
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
