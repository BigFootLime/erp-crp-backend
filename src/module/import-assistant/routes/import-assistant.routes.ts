import { Router, type RequestHandler } from "express";

import pool from "../../../config/database";
import { authorizeRole } from "../../auth/middlewares/auth.middleware";
import { createSecureUpload } from "../../../shared/uploads/secure-upload";
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
const upload = createSecureUpload("import-tabular", { storage: "memory" });

router.use(requireImportAdmin, requireImportTestDatabase);

router.get("/capabilities", controller.getCapabilities);
router.get("/metrics", controller.getOperationsMetrics);
router.get("/batches", controller.getBatches);
router.post("/batches", upload.single("file"), controller.postBatch);
router.get("/batches/:id/report.csv", controller.getBatchReport);
router.get("/batches/:id/rows", controller.getBatchRows);
router.get("/batches/:id", controller.getBatch);
router.put("/batches/:id/preview", controller.putBatchPreview);
router.post("/batches/:id/confirm", controller.postBatchConfirm);

export default router;
