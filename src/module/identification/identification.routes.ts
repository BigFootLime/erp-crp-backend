import { Router } from "express";

import {
  createIdentificationLabel,
  getIdentificationCapabilities,
  getIdentificationLabels,
  invalidateIdentificationLabel,
  printIdentificationLabel,
  replaceIdentificationLabel,
  resolveIdentificationCode,
  syncOfflineIdentificationCodes,
} from "./identification.controller";

const router = Router();

router.get("/capabilities", getIdentificationCapabilities);
router.get("/labels", getIdentificationLabels);
router.post("/labels", createIdentificationLabel);
router.post("/labels/:labelId/print", printIdentificationLabel);
router.post("/labels/:labelId/invalidate", invalidateIdentificationLabel);
router.post("/labels/:labelId/replace", replaceIdentificationLabel);
router.post("/resolve", resolveIdentificationCode);
router.post("/offline/sync", syncOfflineIdentificationCodes);

export default router;
