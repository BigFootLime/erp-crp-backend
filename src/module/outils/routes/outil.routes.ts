// ✅ Route outil : src/module/outils/routes/outil.routes.ts
import { Router } from "express";
import { outilController } from "../controllers/outil.controller";
import { outilSupportController } from "../controllers/outil.controller";

const router = Router();

router.get("/:id", outilController.getById);
router.post("/", outilController.create);

router.get("/familles", outilSupportController.getFamilles);
router.get("/fabricants", outilSupportController.getFabricants);
router.post("/fabricants", outilSupportController.postFabricant);
router.get("/fournisseurs", outilSupportController.getFournisseurs);
router.post("/fournisseurs", outilSupportController.postFournisseur);
router.get("/geometries", outilSupportController.getGeometries);
router.get("/revetements", outilSupportController.getRevetements);
router.get("/aretes", outilSupportController.getAretes);




export default router;