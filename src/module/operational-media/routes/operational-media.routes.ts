import { Router } from "express";
import { downloadOperationalImage, getMediaCapabilities } from "../controllers/operational-media.controller";
const router = Router();
router.get("/capabilities", getMediaCapabilities);
router.get("/:assetId/content", downloadOperationalImage);
export default router;
