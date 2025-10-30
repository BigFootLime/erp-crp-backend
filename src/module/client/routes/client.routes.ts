// src/module/clients/routes/clients.routes.ts
import { Router } from "express";
import { postClient, getClientById, listClients } from "../controllers/client.controller";
import { listClientsAnalytics } from "../controllers/clients.analytics.controller"
import { patchClientPrimaryContact } from "../controllers/client.controller";


const router = Router();

router.post("/", postClient);          // already there (create)
router.get("/", listClients);   
router.get("/analytics", listClientsAnalytics); // new analytics endpoint       // for dropdown/picker with ?q=
router.get("/:id", getClientById);    
router.patch("/:id/contact", patchClientPrimaryContact); // FULL payload for commande


export default router;
