import path from "node:path";

import { Router, type RequestHandler } from "express";
import multer from "multer";

import pool from "../../../config/database";
import { authorizeRole } from "../../auth/middlewares/auth.middleware";
import { HttpError } from "../../../utils/httpError";
import * as controller from "../controllers/import-assistant.controller";
import { assertImportAssistantDatabase } from "../domain/import-database-guard";

const router = Router();
const requireImportAdmin = authorizeRole("Administrateur Systeme et Reseau", "Directeur");
const requireImportTestDatabase: RequestHandler = async (_req, _res, next) => {
  try {
    const result = await pool.query<{ database: string }>(
      "SELECT current_database() AS database"
    );
    assertImportAssistantDatabase(result.rows[0]?.database);
    next();
  } catch (error) {
    next(error);
  }
};
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 1, fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase();
    if (![".xlsx", ".csv"].includes(extension)) {
      callback(new HttpError(400, "UNSUPPORTED_IMPORT_FORMAT", "Format refusé. Utilisez un fichier .xlsx ou .csv."));
      return;
    }
    callback(null, true);
  },
});

router.use(requireImportAdmin, requireImportTestDatabase);

router.get("/capabilities", controller.getCapabilities);
router.get("/batches", controller.getBatches);
router.post("/batches", upload.single("file"), controller.postBatch);
router.get("/batches/:id/report.csv", controller.getBatchReport);
router.get("/batches/:id/rows", controller.getBatchRows);
router.get("/batches/:id", controller.getBatch);
router.put("/batches/:id/preview", controller.putBatchPreview);
router.post("/batches/:id/confirm", controller.postBatchConfirm);

export default router;
