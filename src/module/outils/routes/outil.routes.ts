// src/module/outils/routes/outils.routes.ts
import { Router } from "express";
import { outilController, outilSupportController } from "../controllers/outil.controller";
import { upload } from "../../../middlewares/upload";
import { authenticateToken } from "../../auth/middlewares/auth.middleware";
import { asyncHandler } from "../../../utils/asyncHandler";

const router = Router();

/**
 * =========================
 * SUPPORT (référentiels)
 * =========================
 */
router.get("/familles", asyncHandler(outilSupportController.getFamilles));
router.get("/fabricants", asyncHandler(outilSupportController.getFabricants));
router.post(
  "/fabricants",
  authenticateToken,
  upload.single("logo"),
  asyncHandler(outilSupportController.postFabricant)
);

router.get("/fournisseurs", asyncHandler(outilSupportController.getFournisseurs));
router.post("/fournisseurs", authenticateToken, asyncHandler(outilSupportController.postFournisseur));

router.get("/geometries", asyncHandler(outilSupportController.getGeometries));
router.get("/revetements", asyncHandler(outilSupportController.getRevetements));
router.post("/revetements", authenticateToken, asyncHandler(outilSupportController.postRevetement));

router.get("/aretes", asyncHandler(outilSupportController.getAretes));

/**
 * =========================
 * OUTILS (listing / détails)
 * =========================
 */

// ✅ Nouveau listing filtré/paginé (cards UI)
// GET /outils? id_famille=1&id_geometrie=2&q=abc&only_in_stock=true&limit=50&offset=0
router.get("", asyncHandler(outilController.getFiltered));

// ✅ Low stock
router.get("/low-stock", authenticateToken, asyncHandler(outilController.getLowStock));

// ✅ Détail par id
router.get("/:id", asyncHandler(outilController.getById));

// ✅ Lookup par code barre (référence fabricant)
router.get("/ref_fabricant/:ref_fabricant", asyncHandler(outilController.getByReferenceFabricant));

/**
 * =========================
 * OUTILS (création)
 * =========================
 */
router.post(
  "/",
  authenticateToken,
  upload.fields([
    { name: "esquisse", maxCount: 1 },
    { name: "plan", maxCount: 1 },
    { name: "image", maxCount: 1 },
  ]),
  asyncHandler(outilController.create)
);

/**
 * =========================
 * STOCK (mouvements)
 * =========================
 */

// ➖ Sortie stock (manuel, par id_outil)
router.post("/sortie", authenticateToken, asyncHandler(outilController.sortieStock));

// ➕ Réappro (manuel, par id_outil)
router.post("/reapprovisionner", authenticateToken, asyncHandler(outilController.reapprovisionner));

// 📷 Scan sortie (barcode)
router.post("/scan/sortie", authenticateToken, asyncHandler(outilController.scanSortie));

// 📷 Scan entrée (barcode)
router.post("/scan/entree", authenticateToken, asyncHandler(outilController.scanEntree));

// 🧾 Inventaire set (quantité absolue)
router.post("/inventaire/set", authenticateToken, asyncHandler(outilController.inventaireSet));

export default router;
