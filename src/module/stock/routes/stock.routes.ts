import { Router, type RequestHandler } from "express";
import multer from "multer";

import { authenticateToken, authorizeRole } from "../../auth/middlewares/auth.middleware";
import { ensureTmpStoragePath } from "../../../utils/cerpStorage";
import { HttpError } from "../../../utils/httpError";
import {
  attachStockArticleDocuments,
  attachStockMovementDocuments,
  cancelStockMovement,
  closeStockInventorySession,
  startStockInventorySession,
  approveStockInventorySession,
  cancelStockInventorySession,
  createStockInventorySession,
  createStockArticle,
  previewStockArticleCode,
  createStockArticleFamily,
  createStockMatiereEtat,
  createStockMatiereNuance,
  createStockMatiereSousEtat,
  createStockEmplacement,
  createStockLot,
  createStockLotGenealogy,
  createStockMagasin,
  deactivateStockMagasin,
  activateStockMagasin,
  createStockMovement,
  compensateStockMovement,
  previewStockMovementCompensation,
  previewStockMovement,
  downloadStockArticleDocument,
  downloadStockMovementDocument,
  getStockAnalytics,
  getStockInventorySession,
  getStockArticle,
  listStockArticleCategories,
  listStockArticleFamilies,
  getStockArticlesKpis,
  getStockLot,
  getStockLotGenealogy,
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
  updateStockLotQuality,
  updateStockMagasin,
} from "../controllers/stock.controller";
import {
  getArticleDefinitionTechnique,
  linkArticlePieceTechnique,
  unlinkArticlePieceTechnique,
} from "../controllers/article-piece-link.controller";
import {
  consumeStockReservation,
  createStockReservation,
  getStockReservation,
  listStockReservations,
  releaseStockReservation,
} from "../controllers/stock-reservation.controller";
import {
  ARTICLE_ARCHIVE_ROLES,
  ARTICLE_DOCUMENT_WRITE_ROLES,
  ARTICLE_WRITE_ROLES,
} from "../stock-article.permissions";
import { roleHasStockCapability, type StockCapability } from "../domain/stock-rbac";

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

const requireStockCapability = (capability: StockCapability): RequestHandler => (req, _res, next) => {
  if (!roleHasStockCapability(req.user?.role, capability)) {
    next(new HttpError(403, "STOCK_FORBIDDEN", `Stock capability required: ${capability}`));
    return;
  }
  next();
};

router.get("/analytics", requireStockCapability("read"), getStockAnalytics);
router.get("/article-categories", requireStockCapability("read"), listStockArticleCategories);
router.get("/article-families", requireStockCapability("read"), listStockArticleFamilies);
router.post("/article-families", requireArticleWrite, createStockArticleFamily);
router.get("/matiere-nuances", requireStockCapability("read"), listStockMatiereNuances);
router.post("/matiere-nuances", requireArticleWrite, createStockMatiereNuance);
router.get("/matiere-etats", requireStockCapability("read"), listStockMatiereEtats);
router.post("/matiere-etats", requireArticleWrite, createStockMatiereEtat);
router.get("/matiere-sous-etats", requireStockCapability("read"), listStockMatiereSousEtats);
router.post("/matiere-sous-etats", requireArticleWrite, createStockMatiereSousEtat);
router.get("/articles", requireStockCapability("read"), listStockArticles);
router.get("/articles/kpis", requireStockCapability("read"), getStockArticlesKpis);
router.get("/articles/code-preview", requireStockCapability("read"), previewStockArticleCode);
router.post("/articles", requireArticleWrite, createStockArticle);
router.get("/articles/:id", requireStockCapability("read"), getStockArticle);
router.patch("/articles/:id", requireArticleWrite, updateStockArticle);
router.post("/articles/:id/archive", requireArticleArchive, archiveStockArticle);
router.post("/articles/:id/reactivate", requireArticleArchive, reactivateStockArticle);
router.get("/articles/:id/versions", requireStockCapability("read"), listStockArticleVersions);
router.get("/articles/:id/where-used", requireStockCapability("read"), listStockArticleWhereUsed);

router.get("/inventory-sessions", requireStockCapability("read"), listStockInventorySessions);
router.post("/inventory-sessions", requireStockCapability("inventory_create"), createStockInventorySession);
router.get("/inventory-sessions/:id", requireStockCapability("read"), getStockInventorySession);
router.get("/inventory-sessions/:id/lines", requireStockCapability("read"), listStockInventorySessionLines);
router.post(
  "/inventory-sessions/:id/start",
  requireStockCapability("inventory_create"),
  startStockInventorySession
);
router.put(
  "/inventory-sessions/:id/lines",
  requireStockCapability("inventory_count"),
  upsertStockInventorySessionLine
);
router.post(
  "/inventory-sessions/:id/approve",
  requireStockCapability("inventory_approve"),
  approveStockInventorySession
);
router.post(
  "/inventory-sessions/:id/cancel",
  requireStockCapability("inventory_approve"),
  cancelStockInventorySession
);
router.post(
  "/inventory-sessions/:id/close",
  requireStockCapability("inventory_close"),
  closeStockInventorySession
);

// GPAO B5 — lien Article fabriqué ↔ Pièce technique
router.get("/articles/:id/definition-technique", requireStockCapability("read"), getArticleDefinitionTechnique);
router.post("/articles/:id/link-piece-technique", requireArticleWrite, linkArticlePieceTechnique);
router.delete("/articles/:id/link-piece-technique", requireArticleWrite, unlinkArticlePieceTechnique);

router.get("/articles/:id/documents", requireStockCapability("read"), listStockArticleDocuments);
router.post("/articles/:id/documents", requireArticleDocumentWrite, upload.array("documents[]", 10), attachStockArticleDocuments);
router.delete("/articles/:id/documents/:docId", requireArticleDocumentWrite, removeStockArticleDocument);
router.get(
  "/articles/:id/documents/:docId/file",
  requireStockCapability("read"),
  downloadStockArticleDocument
);

router.get("/magasins", requireStockCapability("read"), listStockMagasins);
router.get("/magasins/kpis", requireStockCapability("read"), getStockMagasinsKpis);
router.post("/magasins", requireStockCapability("referential_manage"), createStockMagasin);
router.get("/magasins/:id", requireStockCapability("read"), getStockMagasin);
router.patch("/magasins/:id", requireStockCapability("referential_manage"), updateStockMagasin);
router.post(
  "/magasins/:id/deactivate",
  requireStockCapability("referential_manage"),
  deactivateStockMagasin
);
router.post("/magasins/:id/activate", requireStockCapability("referential_manage"), activateStockMagasin);
router.post(
  "/magasins/:magasinId/emplacements",
  requireStockCapability("referential_manage"),
  createStockEmplacement
);

router.get("/emplacements", requireStockCapability("read"), listStockEmplacements);
router.patch(
  "/emplacements/:id",
  requireStockCapability("referential_manage"),
  updateStockEmplacement
);

router.get("/lots", requireStockCapability("read"), listStockLots);
router.post("/lots", requireStockCapability("referential_manage"), createStockLot);
router.post(
  "/lots/genealogy",
  requireStockCapability("movement_post"),
  createStockLotGenealogy
);
router.get("/lots/:id", requireStockCapability("read"), getStockLot);
router.patch("/lots/:id", requireStockCapability("referential_manage"), updateStockLot);
router.post(
  "/lots/:id/quality-status",
  requireStockCapability("lot_quality"),
  updateStockLotQuality
);
router.get("/lots/:id/genealogy", requireStockCapability("read"), getStockLotGenealogy);

router.get("/balances", requireStockCapability("read"), listStockBalances);

router.get("/reservations", requireStockCapability("read"), listStockReservations);
router.post(
  "/reservations",
  requireStockCapability("reservation_manage"),
  createStockReservation
);
router.get("/reservations/:id", requireStockCapability("read"), getStockReservation);
router.post(
  "/reservations/:id/release",
  requireStockCapability("reservation_manage"),
  releaseStockReservation
);
router.post(
  "/reservations/:id/consume",
  requireStockCapability("reservation_manage"),
  consumeStockReservation
);

router.get("/movements", requireStockCapability("read"), listStockMovements);
router.post("/movements/preview", requireStockCapability("movement_create"), previewStockMovement);
router.post("/movements", requireStockCapability("movement_create"), createStockMovement);
router.get("/movements/:id", requireStockCapability("read"), getStockMovement);
router.post(
  "/movements/:id/compensation-preview",
  requireStockCapability("movement_compensate"),
  previewStockMovementCompensation
);
router.post(
  "/movements/:id/compensate",
  requireStockCapability("movement_compensate"),
  compensateStockMovement
);
router.post("/movements/:id/post", requireStockCapability("movement_post"), postStockMovement);
router.post("/movements/:id/cancel", requireStockCapability("movement_cancel"), cancelStockMovement);

router.get("/movements/:id/documents", requireStockCapability("read"), listStockMovementDocuments);
router.post(
  "/movements/:id/documents",
  requireStockCapability("documents_manage"),
  upload.array("documents[]"),
  attachStockMovementDocuments
);
router.delete(
  "/movements/:id/documents/:docId",
  requireStockCapability("documents_manage"),
  removeStockMovementDocument
);
router.get(
  "/movements/:id/documents/:docId/file",
  requireStockCapability("read"),
  downloadStockMovementDocument
);

export default router;
