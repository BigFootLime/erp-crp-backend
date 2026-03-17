// src/module/outils/routes/outils.routes.ts
import { Router } from "express";
import { outilController, outilSupportController } from "../controllers/outil.controller";
import { authenticateToken } from "../../auth/middlewares/auth.middleware";
import { asyncHandler } from "../../../utils/asyncHandler";
import {
  outillageFabricantUpload,
  outillageFamilleUpload,
  outillageGeometrieUpload,
  outillageToolUpload,
} from "../utils/outillage-upload";

const router = Router();

/**
 * =========================
 * SUPPORT (référentiels)
 * =========================
 */
router.get("/familles", asyncHandler(outilSupportController.getFamilles));
router.post("/familles", authenticateToken, outillageFamilleUpload.single("image"), asyncHandler(outilSupportController.postFamille));
router.patch("/familles/:id", authenticateToken, outillageFamilleUpload.single("image"), asyncHandler(outilSupportController.patchFamille));
router.get("/fabricants", asyncHandler(outilSupportController.getFabricants));
router.post(
  "/fabricants",
  authenticateToken,
  outillageFabricantUpload.single("logo"),
  asyncHandler(outilSupportController.postFabricant)
);

router.get("/fournisseurs", asyncHandler(outilSupportController.getFournisseurs));
router.post("/fournisseurs", authenticateToken, asyncHandler(outilSupportController.postFournisseur));

router.get("/geometries", asyncHandler(outilSupportController.getGeometries));
router.post("/geometries", authenticateToken, outillageGeometrieUpload.single("image"), asyncHandler(outilSupportController.postGeometrie));
router.patch("/geometries/:id", authenticateToken, outillageGeometrieUpload.single("image"), asyncHandler(outilSupportController.patchGeometrie));
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
router.get("/:id/pricing", authenticateToken, asyncHandler(outilController.getPricing));
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
  outillageToolUpload.fields([
    { name: "esquisse", maxCount: 1 },
    { name: "plan", maxCount: 1 },
    { name: "image", maxCount: 1 },
  ]),
  asyncHandler(outilController.create)
);

router.patch(
  "/:id",
  authenticateToken,
  outillageToolUpload.fields([
    { name: "esquisse", maxCount: 1 },
    { name: "plan", maxCount: 1 },
    { name: "image", maxCount: 1 },
  ]),
  asyncHandler(outilController.update)
);

router.delete("/:id", authenticateToken, asyncHandler(outilController.remove));

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
