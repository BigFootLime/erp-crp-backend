// src/module/clients/routes/clients.routes.ts
import { Router } from "express";
import { postClient, getClientById, listClients, patchClientPrimaryContact, patchClient,  uploadClientLogo,  } from "../controllers/client.controller";
import { listClientsAnalytics } from "../controllers/clients.analytics.controller"
import { uploadClientLogoMulter } from "../upload/client-logo-upload";


const router = Router();

router.post("/", postClient);
router.get("/", listClients);
router.get("/analytics", listClientsAnalytics);
router.get("/:id", getClientById);

// 🆕 upload du logo client
router.post(
  "/:id/logo",
  uploadClientLogoMulter.single("logo"), // champ "logo" = FormData.append("logo", file)
  uploadClientLogo
);

// 🆕 update complet
router.patch("/:id", patchClient);

// déjà existant
router.patch("/:id/contact", patchClientPrimaryContact);


export default router;
