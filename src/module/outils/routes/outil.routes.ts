import { Router } from "express";
import { outilController, outilSupportController } from "../controllers/outil.controller";

const router = Router();

// 🔧 Routes support (familles, fabricants, etc.)
router.get("/familles", outilSupportController.getFamilles);
router.get("/fabricants", outilSupportController.getFabricants);
router.post("/fabricants", outilSupportController.postFabricant);
router.get("/fournisseurs", outilSupportController.getFournisseurs);
router.post("/fournisseurs", outilSupportController.postFournisseur);
router.get("/geometries", outilSupportController.getGeometries);
router.get("/revetements", outilSupportController.getRevetements);
router.get("/aretes", outilSupportController.getAretes);

// 📦 Routes outil principal
router.post("/", outilController.create);
router.get("/:id", outilController.getById); // ⚠️ Toujours à la fin !

export default router;
