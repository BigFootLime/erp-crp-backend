// src/module/clients/routes/clients.routes.ts
import { Router } from "express";
import { postClient, getClientById, listClients, patchClientPrimaryContact, patchClient, } from "../controllers/client.controller";
import { listClientsAnalytics } from "../controllers/clients.analytics.controller"


const router = Router();

router.post("/", postClient);
router.get("/", listClients);
router.get("/analytics", listClientsAnalytics);
router.get("/:id", getClientById);

// 🆕 update complet
router.patch("/:id", patchClient);

// déjà existant
router.patch("/:id/contact", patchClientPrimaryContact);


export default router;
