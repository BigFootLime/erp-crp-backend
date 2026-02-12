import { Router } from "express";
import {
  createFacture,
  deleteFacture,
  generateFacturePdf,
  getFacture,
  getFacturePdf,
  listFactures,
  updateFacture,
} from "../controllers/factures.controller";

const router = Router();

router.get("/", listFactures);
router.get("/:id", getFacture);
router.get("/:id/pdf", getFacturePdf);
router.post("/", createFacture);
router.post("/:id/pdf", generateFacturePdf);
router.patch("/:id", updateFacture);
router.delete("/:id", deleteFacture);

export default router;
