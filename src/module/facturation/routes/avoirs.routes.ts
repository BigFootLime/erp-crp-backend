import { Router } from "express";
import {
  createAvoir,
  deleteAvoir,
  generateAvoirPdf,
  getAvoir,
  getAvoirPdf,
  listAvoirs,
  updateAvoir,
} from "../controllers/avoirs.controller";

const router = Router();

router.get("/", listAvoirs);
router.get("/:id", getAvoir);
router.get("/:id/pdf", getAvoirPdf);
router.post("/", createAvoir);
router.post("/:id/pdf", generateAvoirPdf);
router.patch("/:id", updateAvoir);
router.delete("/:id", deleteAvoir);

export default router;
