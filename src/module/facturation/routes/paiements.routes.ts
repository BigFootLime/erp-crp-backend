import { Router } from "express";
import {
  createPaiement,
  deletePaiement,
  getPaiement,
  listPaiements,
  updatePaiement,
} from "../controllers/paiements.controller";

const router = Router();

router.get("/", listPaiements);
router.get("/:id", getPaiement);
router.post("/", createPaiement);
router.patch("/:id", updatePaiement);
router.delete("/:id", deletePaiement);

export default router;
