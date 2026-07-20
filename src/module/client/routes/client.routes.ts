// src/module/clients/routes/clients.routes.ts
import { Router } from "express";
import { authenticateToken, authorizeRole } from "../../auth/middlewares/auth.middleware";
import {
  archiveClient,
  checkClientDuplicates,
  deleteClient,
  getClientById,
  listClientAddresses,
  listClientContacts,
  listClients,
  patchClient,
  patchClientPrimaryContact,
  postClient,
  postClientContact,
} from "../controllers/client.controller";
import { listClientsAnalytics } from "../controllers/clients.analytics.controller"
import { CLIENT_WRITE_ROLES } from "../client.permissions";
// import { uploadClientLogoMulter } from "../upload/client-logo-upload";


const router = Router();

// Les fiches clients portent des PII (emails, téléphones, SIRET) et des données
// bancaires : aucune route n'est publique. Deny by default (#162).
router.use(authenticateToken);

const requireClientWriteRole = authorizeRole(...CLIENT_WRITE_ROLES);

router.post("/", requireClientWriteRole, postClient);
router.get("/", listClients);
router.get("/analytics", listClientsAnalytics);
// POST (et non GET) : SIRET/TVA/raison sociale ne doivent jamais transiter en query string.
router.post("/duplicate-check", checkClientDuplicates);
router.get("/:clientId/contacts", listClientContacts);
router.post("/:clientId/contacts", requireClientWriteRole, postClientContact);
router.get("/:clientId/addresses", listClientAddresses);
router.get("/:id", getClientById);

// 🆕 upload du logo client
// router.post(
//   "/:id/logo",
//   uploadClientLogoMulter.single("logo"), // champ "logo" = FormData.append("logo", file)
//   uploadClientLogo
// );

// 🆕 update partiel
router.patch("/:id", requireClientWriteRole, patchClient);

// La « suppression » est un archivage logique : aucune destruction physique
// de client/contacts/modes de paiement (traçabilité industrielle, #162).
router.delete("/:id", requireClientWriteRole, deleteClient);

router.post("/:id/archive", requireClientWriteRole, archiveClient);

// deja existant
router.patch("/:id/contact", requireClientWriteRole, patchClientPrimaryContact);


export default router;
