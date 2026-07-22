import { Router } from "express";
import multer from "multer";

import { authenticateToken, authorizeRole } from "../../auth/middlewares/auth.middleware";
import { ensureTmpStoragePath } from "../../../utils/cerpStorage";
import {
  attachStockArticleDocuments,
  attachStockMovementDocuments,
  cancelStockMovement,
  closeStockInventorySession,
  createStockInventorySession,
  createStockArticle,
  previewStockArticleCode,
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
  archiveStockArticle,
  reactivateStockArticle,
  listStockArticleVersions,
  listStockArticleWhereUsed,
  updateStockEmplacement,
  updateStockLot,
  updateStockMagasin,
} from "../controllers/stock.controller";
import {
  getArticleDefinitionTechnique,
  linkArticlePieceTechnique,
  unlinkArticlePieceTechnique,
} from "../controllers/article-piece-link.controller";
import {
  ARTICLE_ARCHIVE_ROLES,
  ARTICLE_DOCUMENT_WRITE_ROLES,
  ARTICLE_WRITE_ROLES,
} from "../stock-article.permissions";

const router = Router();

const tmpBaseDir = ensureTmpStoragePath("stock");

const upload = multer({
  dest: tmpBaseDir,
  limits: {
    fileSize: 25 * 1024 * 1024,
  },
});

router.use(authenticateToken);

const requireArticleWrite = authorizeRole(...ARTICLE_WRITE_ROLES);
const requireArticleArchive = authorizeRole(...ARTICLE_ARCHIVE_ROLES);
const requireArticleDocumentWrite = authorizeRole(...ARTICLE_DOCUMENT_WRITE_ROLES);

router.get("/analytics", getStockAnalytics);
router.get("/article-categories", listStockArticleCategories);
router.get("/article-families", listStockArticleFamilies);
router.post("/article-families", requireArticleWrite, createStockArticleFamily);
router.get("/matiere-nuances", listStockMatiereNuances);
router.post("/matiere-nuances", requireArticleWrite, createStockMatiereNuance);
router.get("/matiere-etats", listStockMatiereEtats);
router.post("/matiere-etats", requireArticleWrite, createStockMatiereEtat);
router.get("/matiere-sous-etats", listStockMatiereSousEtats);
router.post("/matiere-sous-etats", requireArticleWrite, createStockMatiereSousEtat);
router.get("/articles", listStockArticles);
router.get("/articles/kpis", getStockArticlesKpis);
router.get("/articles/code-preview", previewStockArticleCode);
router.post("/articles", requireArticleWrite, createStockArticle);
router.get("/articles/:id", getStockArticle);
router.patch("/articles/:id", requireArticleWrite, updateStockArticle);
router.post("/articles/:id/archive", requireArticleArchive, archiveStockArticle);
router.post("/articles/:id/reactivate", requireArticleArchive, reactivateStockArticle);
router.get("/articles/:id/versions", listStockArticleVersions);
router.get("/articles/:id/where-used", listStockArticleWhereUsed);

router.get("/inventory-sessions", listStockInventorySessions);
router.post("/inventory-sessions", createStockInventorySession);
router.get("/inventory-sessions/:id", getStockInventorySession);
router.get("/inventory-sessions/:id/lines", listStockInventorySessionLines);
router.put("/inventory-sessions/:id/lines", upsertStockInventorySessionLine);
router.post("/inventory-sessions/:id/close", closeStockInventorySession);

// GPAO B5 — lien Article fabriqué ↔ Pièce technique
router.get("/articles/:id/definition-technique", getArticleDefinitionTechnique);
router.post("/articles/:id/link-piece-technique", requireArticleWrite, linkArticlePieceTechnique);
router.delete("/articles/:id/link-piece-technique", requireArticleWrite, unlinkArticlePieceTechnique);

router.get("/articles/:id/documents", listStockArticleDocuments);
router.post("/articles/:id/documents", requireArticleDocumentWrite, upload.array("documents[]", 10), attachStockArticleDocuments);
router.delete("/articles/:id/documents/:docId", requireArticleDocumentWrite, removeStockArticleDocument);
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
