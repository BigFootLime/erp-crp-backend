import { Router } from "express"
import fs from "node:fs"
import multer from "multer"
import path from "node:path"

import { authenticateToken } from "../../auth/middlewares/auth.middleware"
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

const ensureDir = (dir: string) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

const tmpBaseDir = path.resolve("uploads/tmp/receptions")
ensureDir(tmpBaseDir)

const upload = multer({
  dest: tmpBaseDir,
  limits: { fileSize: 25 * 1024 * 1024, files: 10 },
})

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
