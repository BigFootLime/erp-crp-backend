import { Router } from "express";
import fs from "fs";
import multer from "multer";
import path from "path";

import { authenticateToken } from "../../auth/middlewares/auth.middleware";
import {
  attachStockArticleDocuments,
  attachStockMovementDocuments,
  cancelStockMovement,
  closeStockInventorySession,
  createStockInventorySession,
  createStockArticle,
  createStockArticleFamily,
  createStockMatiereEtat,
  createStockMatiereNuance,
  createStockMatiereSousEtat,
  createStockEmplacement,
  createStockLot,
  createStockMagasin,
  deactivateStockMagasin,
  activateStockMagasin,
  createStockMovement,
  downloadStockArticleDocument,
  downloadStockMovementDocument,
  getStockAnalytics,
  getStockInventorySession,
  getStockArticle,
  listStockArticleCategories,
  listStockArticleFamilies,
  getStockArticlesKpis,
  getStockLot,
  getStockMagasin,
  getStockMagasinsKpis,
  getStockMovement,
  listStockInventorySessionLines,
  listStockInventorySessions,
  listStockArticleDocuments,
  listStockArticles,
  listStockBalances,
  listStockEmplacements,
  listStockLots,
  listStockMagasins,
  listStockMatiereEtats,
  listStockMatiereNuances,
  listStockMatiereSousEtats,
  listStockMovementDocuments,
  listStockMovements,
  postStockMovement,
  removeStockArticleDocument,
  removeStockMovementDocument,
  upsertStockInventorySessionLine,
  updateStockArticle,
  updateStockEmplacement,
  updateStockLot,
  updateStockMagasin,
} from "../controllers/stock.controller";

const router = Router();

const ensureDir = (dir: string) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
};

const tmpBaseDir = path.resolve("uploads/tmp/stock");
ensureDir(tmpBaseDir);

const upload = multer({
  dest: tmpBaseDir,
  limits: {
    fileSize: 25 * 1024 * 1024,
  },
});

router.use(authenticateToken);

router.get("/analytics", getStockAnalytics);
router.get("/article-categories", listStockArticleCategories);
router.get("/article-families", listStockArticleFamilies);
router.post("/article-families", createStockArticleFamily);
router.get("/matiere-nuances", listStockMatiereNuances);
router.post("/matiere-nuances", createStockMatiereNuance);
router.get("/matiere-etats", listStockMatiereEtats);
router.post("/matiere-etats", createStockMatiereEtat);
router.get("/matiere-sous-etats", listStockMatiereSousEtats);
router.post("/matiere-sous-etats", createStockMatiereSousEtat);
router.get("/articles", listStockArticles);
router.get("/articles/kpis", getStockArticlesKpis);
router.post("/articles", createStockArticle);
router.get("/articles/:id", getStockArticle);
router.patch("/articles/:id", updateStockArticle);

router.get("/inventory-sessions", listStockInventorySessions);
router.post("/inventory-sessions", createStockInventorySession);
router.get("/inventory-sessions/:id", getStockInventorySession);
router.get("/inventory-sessions/:id/lines", listStockInventorySessionLines);
router.put("/inventory-sessions/:id/lines", upsertStockInventorySessionLine);
router.post("/inventory-sessions/:id/close", closeStockInventorySession);

router.get("/articles/:id/documents", listStockArticleDocuments);
router.post("/articles/:id/documents", upload.array("documents[]"), attachStockArticleDocuments);
router.delete("/articles/:id/documents/:docId", removeStockArticleDocument);
router.get("/articles/:id/documents/:docId/file", downloadStockArticleDocument);

router.get("/magasins", listStockMagasins);
router.get("/magasins/kpis", getStockMagasinsKpis);
router.post("/magasins", createStockMagasin);
router.get("/magasins/:id", getStockMagasin);
router.patch("/magasins/:id", updateStockMagasin);
router.post("/magasins/:id/deactivate", deactivateStockMagasin);
router.post("/magasins/:id/activate", activateStockMagasin);
router.post("/magasins/:magasinId/emplacements", createStockEmplacement);

router.get("/emplacements", listStockEmplacements);
router.patch("/emplacements/:id", updateStockEmplacement);

router.get("/lots", listStockLots);
router.post("/lots", createStockLot);
router.get("/lots/:id", getStockLot);
router.patch("/lots/:id", updateStockLot);

router.get("/balances", listStockBalances);

router.get("/movements", listStockMovements);
router.post("/movements", createStockMovement);
router.get("/movements/:id", getStockMovement);
router.post("/movements/:id/post", postStockMovement);
router.post("/movements/:id/cancel", cancelStockMovement);

router.get("/movements/:id/documents", listStockMovementDocuments);
router.post("/movements/:id/documents", upload.array("documents[]"), attachStockMovementDocuments);
router.delete("/movements/:id/documents/:docId", removeStockMovementDocument);
router.get("/movements/:id/documents/:docId/file", downloadStockMovementDocument);

export default router;
