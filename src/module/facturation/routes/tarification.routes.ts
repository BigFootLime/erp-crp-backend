import { Router } from "express";
import {
  createTarificationClient,
  deleteTarificationClient,
  getTarificationClient,
  listTarificationClients,
  updateTarificationClient,
} from "../controllers/tarification.controller";

const router = Router();

router.get("/clients", listTarificationClients);
router.get("/clients/:id", getTarificationClient);
router.post("/clients", createTarificationClient);
router.patch("/clients/:id", updateTarificationClient);
router.delete("/clients/:id", deleteTarificationClient);

export default router;
