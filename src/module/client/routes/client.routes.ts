// src/module/clients/routes/clients.routes.ts
import { Router } from "express";
import { authenticateToken } from "../../auth/middlewares/auth.middleware";
import {
  archiveClient,
  deleteClient,
  getClientById,
  listClientAddresses,
  listClientContacts,
  listClients,
  patchClient,
  patchClientPrimaryContact,
  postClient,
} from "../controllers/client.controller";
import { listClientsAnalytics } from "../controllers/clients.analytics.controller"
// import { uploadClientLogoMulter } from "../upload/client-logo-upload";


const router = Router();

router.post("/", authenticateToken, postClient);
router.get("/", listClients);
router.get("/analytics", listClientsAnalytics);
router.get("/:clientId/contacts", listClientContacts);
router.get("/:clientId/addresses", listClientAddresses);
router.get("/:id", getClientById);

// 🆕 upload du logo client
// router.post(
//   "/:id/logo",
//   uploadClientLogoMulter.single("logo"), // champ "logo" = FormData.append("logo", file)
//   uploadClientLogo
// );

// 🆕 update complet
router.patch("/:id", authenticateToken, patchClient);

router.delete("/:id", authenticateToken, deleteClient);

router.post("/:id/archive", authenticateToken, archiveClient);

// deja existant
router.patch("/:id/contact", authenticateToken, patchClientPrimaryContact);


export default router;
