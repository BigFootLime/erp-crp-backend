import { Router } from "express";
import {
  createAffaire,
  deleteAffaire,
  getAffaire,
  listAffaires,
  updateAffaire,
} from "../controllers/affaire.controller";

const router = Router();

router.get("/", listAffaires);
router.get("/:id", getAffaire);
router.post("/", createAffaire);
router.patch("/:id", updateAffaire);
router.delete("/:id", deleteAffaire);

export default router;
