import { Router } from "express";
import fs from "node:fs";
import multer from "multer";
import path from "node:path";

import { authenticateToken } from "../../auth/middlewares/auth.middleware";
import {
  attachCertificats,
  createEquipement,
  deleteEquipement,
  downloadCertificatFile,
  getEquipement,
  listCertificats,
  listEquipements,
  metrologieAlerts,
  metrologieKpis,
  patchEquipement,
  removeCertificat,
  upsertPlan,
} from "../controllers/metrologie.controller";

const ensureDir = (dir: string) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
};

const tmpBaseDir = path.resolve("uploads/tmp/metrologie");
ensureDir(tmpBaseDir);

const upload = multer({
  dest: tmpBaseDir,
  limits: {
    fileSize: 25 * 1024 * 1024,
  },
});

const router = Router();
router.use(authenticateToken);

router.get("/kpis", metrologieKpis);
router.get("/alerts", metrologieAlerts);

router.get("/equipements", listEquipements);
router.post("/equipements", createEquipement);
router.get("/equipements/:id", getEquipement);
router.patch("/equipements/:id", patchEquipement);
router.delete("/equipements/:id", deleteEquipement);

router.put("/equipements/:id/plan", upsertPlan);

router.get("/equipements/:id/certificats", listCertificats);
router.post("/equipements/:id/certificats", upload.array("documents[]"), attachCertificats);
router.delete("/equipements/:id/certificats/:certificatId", removeCertificat);
router.get("/equipements/:id/certificats/:certificatId/file", downloadCertificatFile);

export default router;
