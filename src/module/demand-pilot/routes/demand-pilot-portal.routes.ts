import { Router } from "express";
import { requireClientTransactions } from "../../client-portal/domain/transactional-rollout";
import { authenticateClientPortal } from "../../client-portal/middlewares/client-portal-auth.middleware";
import { createSecureUpload } from "../../../shared/uploads/secure-upload";
import * as controller from "../controllers/demand-pilot.controller";
const router = Router(),
  upload = createSecureUpload("import-tabular", { storage: "memory" });
router.use(authenticateClientPortal);
router.use(requireClientTransactions);
router.get("/", controller.listPortal);
router.post("/preview", upload.single("file"), controller.previewPortal);
router.post("/imports", controller.importPortal);
router.post("/manual", controller.importPortal);
router.get("/:id", controller.getPortal);
router.post("/:id/response", controller.responsePortal);
export default router;
