import { Router } from "express";
import fs from "fs";
import multer from "multer";
import path from "path";

import { authenticateToken } from "../../auth/middlewares/auth.middleware";
import {
  attachStockArticleDocuments,
  attachStockMovementDocuments,
  cancelStockMovement,
  createStockArticle,
  createStockEmplacement,
  createStockLot,
  createStockMagasin,
  createStockMovement,
  downloadStockArticleDocument,
  downloadStockMovementDocument,
  getStockArticle,
  getStockArticlesKpis,
  getStockLot,
  getStockMagasin,
  getStockMagasinsKpis,
  getStockMovement,
  listStockArticleDocuments,
  listStockArticles,
  listStockBalances,
  listStockEmplacements,
  listStockLots,
  listStockMagasins,
  listStockMovementDocuments,
  listStockMovements,
  postStockMovement,
  removeStockArticleDocument,
  removeStockMovementDocument,
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

router.get("/articles", listStockArticles);
router.get("/articles/kpis", getStockArticlesKpis);
router.post("/articles", createStockArticle);
router.get("/articles/:id", getStockArticle);
router.patch("/articles/:id", updateStockArticle);

router.get("/articles/:id/documents", listStockArticleDocuments);
router.post("/articles/:id/documents", upload.array("documents[]"), attachStockArticleDocuments);
router.delete("/articles/:id/documents/:docId", removeStockArticleDocument);
router.get("/articles/:id/documents/:docId/file", downloadStockArticleDocument);

router.get("/magasins", listStockMagasins);
router.get("/magasins/kpis", getStockMagasinsKpis);
router.post("/magasins", createStockMagasin);
router.get("/magasins/:id", getStockMagasin);
router.patch("/magasins/:id", updateStockMagasin);
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
