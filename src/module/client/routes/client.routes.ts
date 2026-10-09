// src/module/clients/routes/clients.routes.ts
import { Router } from "express";
import { authenticateToken, authorizeRole } from "../../auth/middlewares/auth.middleware";
import {
  archiveClient,
  checkClientDuplicates,
  deleteClient,
  downloadClientCreationSnapshot,
  getClientById,
  getClientCreationSnapshot,
  listClientAddresses,
  listClientContacts,
  listClients,
  patchClient,
  patchClientPrimaryContact,
  previewClientCreationSnapshot,
  postClient,
  postClientContact,
  printClientCreationSnapshot,
  listClientOfficialDocuments,
  postClientOfficialDocument,
  previewClientOfficialDocument,
  downloadClientOfficialDocument,
  printClientOfficialDocument,
} from "../controllers/client.controller";
import { listClientsAnalytics } from "../controllers/clients.analytics.controller"
import { CLIENT_WRITE_ROLES } from "../client.permissions";
import { verifyClientElectronicInvoiceAddress } from "../../facturation/electronic-invoicing/electronic-invoice-directory.controller";
import { requireFinanceCapability } from "../../facturation/middlewares/finance-authorization.middleware";
import { postCrmCommand, readClientCrm, readCrmFollowups } from "../controllers/client-crm.controller";
import { listContracts, listContractArticles, readContract, postContractCommand, listContractCalls } from "../controllers/client-contract.controller";
import { listLegacyContractOrders, readLegacyContractPreview, postLegacyContractAssociation } from "../controllers/client-contract-legacy.controller";
import { listClientContractForecasts, postClientContractForecastCommand } from "../controllers/client-contract-forecast.controller";
import { readClientContractCoverage } from "../controllers/client-contract-coverage.controller";
// import { uploadClientLogoMulter } from "../upload/client-logo-upload";


const router = Router();

// Les fiches clients portent des PII (emails, téléphones, SIRET) et des données
// bancaires : aucune route n'est publique. Deny by default (#162).
router.use(authenticateToken);

const requireClientWriteRole = authorizeRole(...CLIENT_WRITE_ROLES);

router.post("/", requireClientWriteRole, postClient);
router.get("/", listClients);
router.get("/analytics", listClientsAnalytics);
router.get("/crm/followups", readCrmFollowups);
router.get("/:id/crm", readClientCrm);
router.post("/:id/crm/commands", requireClientWriteRole, postCrmCommand);
router.get("/:id/contracts", listContracts);
router.get("/:id/contracts/articles", listContractArticles);
router.get("/:id/contracts/:contractId/calls", listContractCalls);
router.get("/:id/contracts/:contractId/coverage", readClientContractCoverage);
router.get("/:id/contracts/:contractId/forecasts", listClientContractForecasts);
router.get("/:id/contracts/:contractId/forecasts/:forecastId/history", listClientContractForecasts);
router.post("/:id/contracts/:contractId/forecasts/commands", requireClientWriteRole, postClientContractForecastCommand);
router.get("/:id/contracts/:contractId/legacy-orders", listLegacyContractOrders);
router.get("/:id/contracts/:contractId/legacy-orders/:commandeId/preview", readLegacyContractPreview);
router.post("/:id/contracts/:contractId/legacy-orders/associations", requireClientWriteRole, postLegacyContractAssociation);
router.get("/:id/contracts/:contractId", readContract);
router.post("/:id/contracts/commands", requireClientWriteRole, postContractCommand);
// POST (et non GET) : SIRET/TVA/raison sociale ne doivent jamais transiter en query string.
router.post("/duplicate-check", checkClientDuplicates);
router.get("/:clientId/contacts", listClientContacts);
router.post("/:clientId/contacts", requireClientWriteRole, postClientContact);
router.get("/:clientId/addresses", listClientAddresses);
// Immutable internal creation snapshot; no issue/reissue surface is exposed here.
router.get("/:id/creation-snapshot", getClientCreationSnapshot);
router.get("/:id/creation-snapshot/:documentId/preview", previewClientCreationSnapshot);
router.get("/:id/creation-snapshot/:documentId/download", downloadClientCreationSnapshot);
router.post("/:id/creation-snapshot/:documentId/print-intents", printClientCreationSnapshot);
// Consolidated current client fiche: separately versioned and archived in GED.
router.get("/:id/official-documents", listClientOfficialDocuments);
router.post("/:id/official-documents", requireClientWriteRole, postClientOfficialDocument);
router.get("/:id/official-documents/:documentId/preview", previewClientOfficialDocument);
router.get("/:id/official-documents/:documentId/download", downloadClientOfficialDocument);
router.post("/:id/official-documents/:documentId/print-intents", printClientOfficialDocument);
router.get("/:id", getClientById);
router.post(
  "/:id/electronic-invoicing/verify",
  requireClientWriteRole,
  requireFinanceCapability("einvoice_admin"),
  verifyClientElectronicInvoiceAddress
);

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
