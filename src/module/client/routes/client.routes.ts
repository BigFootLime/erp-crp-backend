// src/module/clients/routes/clients.routes.ts
import { Router } from "express";
import { postClient, getClientById, listClients } from "../controllers/client.controller";

const router = Router();

router.post("/", postClient);          // already there (create)
router.get("/", listClients);          // for dropdown/picker with ?q=
router.get("/:id", getClientById);     // FULL payload for commande

export default router;
