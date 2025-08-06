import { Router } from "express";
import { outilController, outilSupportController } from "../controllers/outil.controller";
import { upload } from "../../../middlewares/upload";
import { authenticateToken } from "../../auth/middlewares/auth.middleware"; // ✅ CORRECTION
import { asyncHandler } from "../../../utils/asyncHandler";


const router = Router();

// 🔧 Routes support (familles, fabricants, etc.)
router.get("/familles", outilSupportController.getFamilles);
router.get("/fabricants", outilSupportController.getFabricants);
router.post("/fabricants", upload.single("logo"), outilSupportController.postFabricant);
router.get("/fournisseurs", outilSupportController.getFournisseurs);
router.post("/fournisseurs", outilSupportController.postFournisseur);
router.get("/geometries", outilSupportController.getGeometries);
router.get("/revetements", outilSupportController.getRevetements);
router.get("/aretes", outilSupportController.getAretes);
router.post("/revetements", outilSupportController.postRevetement);
router.get(
    "/ref_fabricant/:ref_fabricant",
    asyncHandler(outilController.getByReferenceFabricant)
  );
  

router.post(
    "/sortie",
    authenticateToken,
    asyncHandler(outilController.sortieStock) // ✅ FIX ici
  ); // ✅ FIX
router.get("/", outilController.getAll);



// 📦 Routes outil principal
router.post(
    "/",
    upload.fields([
        { name: "esquisse", maxCount: 1 },
        { name: "plan", maxCount: 1 },
        { name: "image", maxCount: 1 },
    ]),
    outilController.create
);
router.get("/:id", outilController.getById);

router.post(
  "/reapprovisionner",
  authenticateToken,
  asyncHandler(outilController.reapprovisionner)
);

export default router;
