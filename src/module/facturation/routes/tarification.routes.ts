import { Router } from "express";
import {
  createTarificationClient,
  deleteTarificationClient,
  getTarificationClient,
  listTarificationClients,
  updateTarificationClient,
} from "../controllers/tarification.controller";
import { requireFinanceCapability } from "../middlewares/finance-authorization.middleware";

const router = Router();

router.get("/clients", requireFinanceCapability("read"), listTarificationClients);
router.get("/clients/:id", requireFinanceCapability("read"), getTarificationClient);
router.post("/clients", requireFinanceCapability("settings_manage"), createTarificationClient);
router.patch("/clients/:id", requireFinanceCapability("settings_manage"), updateTarificationClient);
router.delete("/clients/:id", requireFinanceCapability("settings_manage"), deleteTarificationClient);

export default router;
