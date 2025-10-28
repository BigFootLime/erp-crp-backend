// src/module/clients/routes/clients.routes.ts
import { Router } from "express";
import { postClient, getClientById, listClients } from "../controllers/client.controller";
import { listClientsAnalytics } from "../controllers/clients.analytics.controller"

const router = Router();

router.post("/", postClient);          // already there (create)
router.get("/", listClients);          // for dropdown/picker with ?q=
router.get("/:id", getClientById);     // FULL payload for commande
router.get("/analytics", listClientsAnalytics); // new analytics endpoint

export default router;
