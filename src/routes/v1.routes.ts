// src/routes/v1.routes.ts
import { Router } from "express"
import authRoutes from "../module/auth/routes/auth.routes"
import terminalRoutes from "../module/terminals/routes/terminals.routes"
import { authenticateToken } from "../module/auth/middlewares/auth.middleware"
import outilRoutes from "../module/outils/routes/outil.routes"
import bankingInfoRoutes from "../module/banking-info/routes/banking-info.routes"
import commandeClientRoutes from "../module/commande-client/routes/commande-client.routes"
import clientRoutes from "../module/client/routes/client.routes";
import paymentModeRoutes from "../module/payment-mode/routes/payment-modes.routes";
import billerRoutes from "../module/biller/routes/biller.routes";
import piecesfamiliesRoutes from "../module/pieces-families/routes/pieces-families.routes"
import CFRoutes from "../module/centre-frais/routes/centre-frais.routes"
import piecesTechniquesRoutes from "../module/pieces-techniques/routes/pieces-techniques.routes"
import auditLogsRoutes from "../module/audit-logs/routes/audit-logs.routes"
import adminRoutes from "../module/admin/routes/admin.routes";
import affaireRoutes from "../module/affaire/routes/affaire.routes";
import devisRoutes from "../module/devis/routes/devis.routes";
import facturesRoutes from "../module/facturation/routes/factures.routes";
import avoirsRoutes from "../module/facturation/routes/avoirs.routes";
import paiementsRoutes from "../module/facturation/routes/paiements.routes";
import proformaRoutes from "../module/facturation/routes/proforma.routes";
import tarificationRoutes from "../module/facturation/routes/tarification.routes";
import reportingRoutes from "../module/facturation/routes/reporting.routes";
import reminderRoutes from "../module/facturation/routes/reminders.routes";
import productionRoutes from "../module/production/routes/production.routes";
import productionReadinessRoutes from "../module/production-readiness/routes/production-readiness.routes";
import productionExecutionRoutes from "../module/production/routes/production-execution.routes";
import productionStationRoutes from "../module/production/routes/station.routes";
import ofVersioningRoutes from "../module/production/routes/of-versioning.routes";
import qualiteRoutes from "../module/qualite/routes/qualite.routes";
import quality360Routes from "../module/qualite/routes/quality-360.routes";
import livraisonsRoutes from "../module/livraisons/routes/livraisons.routes";
import planningRoutes from "../module/planning/routes/planning.routes";
import stockRoutes from "../module/stock/routes/stock.routes";
import programmationRoutes from "../module/programmation/routes/programmation.routes";
import operationDossiersRoutes from "../module/operation-dossiers/routes/operation-dossiers.routes";
import fournisseursRoutes from "../module/fournisseurs/routes/fournisseurs.routes";
import commandeFournisseurRoutes from "../module/commande-fournisseur/routes/commande-fournisseur.routes";
import procurementReliabilityRoutes from "../module/procurement-reliability/routes/procurement-reliability.routes";
import replenishmentProposalRoutes from "../module/commande-fournisseur/routes/replenishment-proposal.routes";
import receptionsRoutes from "../module/receptions/routes/receptions.routes";
import metrologieRoutes from "../module/metrologie/routes/metrologie.routes";
import metrology360Routes from "../module/metrologie/routes/metrology-360.routes";
import codesRoutes from "../module/codes/routes/codes.routes";
import notificationsRoutes from "../module/notifications/routes/notifications.routes";
import chatRoutes from "../module/chat/routes/chat.routes";
import usersRoutes from "../module/users/routes/users.routes";
import marginEngineRoutes from "../module/margin-engine/routes/margin-engine.routes";
import electronicInvoiceWebhookRoutes from "../module/facturation/electronic-invoicing/electronic-invoice-webhook.routes";
import electronicInvoiceDirectoryRoutes from "../module/facturation/electronic-invoicing/electronic-invoice-directory.routes";
import electronicInvoiceReportingRoutes from "../module/facturation/electronic-invoicing/electronic-invoice-reporting.routes";
import accountingExportRoutes from "../module/accounting-export/accounting-export.routes";
import openApiRoutes from "../swagger/openapi.routes";
import webhookAdminRoutes from "../module/integrations/webhooks/webhook.routes";
import clientPortalRoutes from "../module/client-portal/routes/client-portal.routes";
import clientPortalAdminRoutes from "../module/client-portal/routes/client-portal-admin.routes";
import identificationRoutes from "../module/identification/identification.routes";
import operationalMediaRoutes from "../module/operational-media/routes/operational-media.routes";
import subcontractRoutes from "../module/subcontract/subcontract.routes";
import supplierInvoiceRoutes from "../module/supplier-invoices/supplier-invoice.routes";
import onboardingRoutes from "../module/onboarding/routes/onboarding.routes";
import demandPilotRoutes from "../module/demand-pilot/routes/demand-pilot.routes";
import demandPilotPortalRoutes from "../module/demand-pilot/routes/demand-pilot-portal.routes";
import supplierSandboxRoutes from "../module/supplier-sandbox/routes/supplier-sandbox.routes";
import supplierPortalRoutes from "../module/supplier-portal/routes/supplier-portal.routes";
import supplierPortalAdminRoutes from "../module/supplier-portal/routes/supplier-portal-admin.routes";

import traceabilityRoutes from "../module/traceability/routes/traceability.routes"
import traceability360Routes from "../module/traceability/routes/traceability-360.routes"
import asbuiltRoutes from "../module/asbuilt/routes/asbuilt.routes"
import locksRoutes from "../module/locks/routes/locks.routes"
import tempsDeplacementsRoutes from "../module/temps-deplacements/routes/temps-deplacements.routes"
import tempsDeplacementsDeviceRoutes from "../module/temps-deplacements/routes/temps-deplacements-device.routes"
import projectOfficeRoutes from "../module/project-office/routes/project-office.routes"
import gedRoutes from "../module/ged/routes/ged.routes"
import gammesRoutes from "../module/gammes/routes/gammes.routes"
import surfaceFinishRoutes from "../module/surface-finish/routes/surface-finish.routes"
import surfaceFinishGammeRoutes from "../module/surface-finish/routes/surface-finish-gamme.routes"
import pieceTechniqueVersionsRoutes from "../module/gammes/routes/piece-technique-versions.routes"
import methodesRoutes from "../module/methodes/routes/methodes.routes"
import importAssistantRoutes from "../module/import-assistant/routes/import-assistant.routes"
import dataCutoverRoutes from "../module/data-cutover/routes/data-cutover.routes"
import accessControlRoutes from "../module/access-control/routes/access-control.routes"
import dashboardGovernanceRoutes from "../module/dashboard-governance/routes/dashboard-governance.routes"
import referenceDataRoutes from "../module/reference-data/routes/reference-data.routes"
import commercialReferencesRoutes from "../module/commercial-references/routes/commercial-references.routes"
import { moduleAccessGate } from "../module/access-control/middlewares/module-access-gate"
import { mountOrderedRouteGroup } from "./route-mount-order"
import { runWithAccountModuleAccessScope } from "../module/access-control/context/account-module-access.context"
import documentServiceCapabilitiesRoutes from "../shared/document-services/document-service-capabilities.routes"
import entreprisesRoutes from "../module/entreprises/routes/entreprises.routes";
import { intercompanyDeliveryRoutes, intercompanyRequestRoutes, intercompanyPurchaseTrackingRoutes } from "../module/entreprises/intercompany/intercompany.routes";
import intercompanyFulfilmentRoutes from "../module/commande-client/routes/intercompany-fulfilment.routes";
const router = Router()

router.use((_req, _res, next) => runWithAccountModuleAccessScope(next))

// --- Routes publiques (avant authentification) ---
router.use("/auth", authRoutes)
router.use("/entreprises", entreprisesRoutes)
router.use("/intercompany", intercompanyDeliveryRoutes)
router.use("/terminals", terminalRoutes)
router.use("/portal", clientPortalRoutes)
// Customer demand uses the verified portal account binding; it never trusts a client_id from the body.
router.use("/client-portal/demand", demandPilotPortalRoutes)
router.use("/supplier-sandbox", supplierSandboxRoutes)
router.use("/supplier-portal", supplierPortalRoutes)
router.use("/electronic-invoicing/webhooks", electronicInvoiceWebhookRoutes)
router.use(openApiRoutes)
// Borne physique : les commandes sont authentifiées par le token opaque de la
// borne. Ce routeur n'expose ni données RH ni administration.
router.use("/time-clock", tempsDeplacementsDeviceRoutes)

// 🔒 Socle d'authentification : toute route sous /api/v1 définie APRÈS cette
// ligne exige un JWT valide. Les rôles restent descriptifs ; l'autorisation
// métier est portée par le compte et le module au middleware suivant.
router.use(authenticateToken)

// 🔒 Tour de contrôle des accès (#326) : filtrage module par compte, monté avant tout
// module métier pour qu'aucune surface future n'y échappe par oubli. Une fois le
// module autorisé, les anciens gardes de rôle deviennent de simples compatibilités.
router.use(moduleAccessGate)

// Shared, authenticated and permission-safe dependency truth. It intentionally
// sits outside the GED module gate so every business module that can produce an
// archived PDF receives the same status without gaining access to GED content.
router.use("/service-status", documentServiceCapabilitiesRoutes)

// Shared authenticated endpoint; it resolves and enforces the owner module
// from the opaque asset identity before a byte is read.
router.use("/operational-media", operationalMediaRoutes)

// Gouvernance transverse de l'accueil : rollback ARIANE/V2 et métriques
// d'adoption agrégées. Ce n'est pas un module métier restrictible.
router.use("/dashboard-governance", dashboardGovernanceRoutes)
// Demand evidence and decisions are separate from the planning-central industrial solver.
router.use("/demand-pilot", demandPilotRoutes)

router.use("/outils", outilRoutes)
router.use("/banking-info", bankingInfoRoutes)  
router.use("/commandes/intercompany/requests", intercompanyRequestRoutes)
router.use("/commandes/intercompany/fulfilment-receipts", intercompanyFulfilmentRoutes)
router.use("/commandes", commandeClientRoutes) // ✅  
router.use("/clients", clientRoutes);
router.use("/payment-modes", paymentModeRoutes);  
router.use("/billers", billerRoutes);   
router.use("/pieces-families", piecesfamiliesRoutes) 
router.use("/centre-frais", CFRoutes)     
router.use("/pieces-techniques", piecesTechniquesRoutes)
router.use("/piece-technique-versions", pieceTechniqueVersionsRoutes) // GPAO B2.2 — gammes par version
// Bibliothèque de finitions (#210) : la configuration de la finition d'une
// opération est montée AVANT le routeur historique des gammes pour déclarer ses
// capacités fines sans hériter des gardes hérités. Le routeur historique reste
// inchangé pour les écrans en production.
mountOrderedRouteGroup(router, [
  { prefix: "/gammes", router: surfaceFinishGammeRoutes },
  { prefix: "/gammes", router: gammesRoutes }, // GPAO B2.2 — gammes + opérations
])
// Référentiels Méthodes : familles machine, centres de frais tarifés, sélecteur
// de machines. Rattaché au module d'accès « Données techniques » (#326).
router.use("/methodes", methodesRoutes)
router.use("/finitions", surfaceFinishRoutes)                         // #210 — bibliothèque de finitions
router.use("/audit-logs", auditLogsRoutes)
// Tour de contrôle des accès (#326) montée AVANT le routeur admin historique : elle
// est gardée par le statut superadmin et ne doit pas hériter de son authorizeRole.
mountOrderedRouteGroup(router, [
  { prefix: "/admin/access", router: accessControlRoutes },
  { prefix: "/admin/webhooks", router: webhookAdminRoutes },
  { prefix: "/admin/client-portal", router: clientPortalAdminRoutes },
])
router.use("/supplier-portal-admin", supplierPortalAdminRoutes);
mountOrderedRouteGroup(router, [
  { prefix: "/admin/reference-data", router: referenceDataRoutes },
  // Resolve delegated ERP configuration before the legacy admin superadmin guard.
  { prefix: "/admin/onboarding", router: onboardingRoutes },
  { prefix: "/admin", router: adminRoutes },
])
router.use("/affaires", affaireRoutes);
router.use("/devis", devisRoutes);
router.use(commercialReferencesRoutes);
mountOrderedRouteGroup(router, [
  { prefix: "/electronic-invoicing", router: electronicInvoiceDirectoryRoutes },
  { prefix: "/electronic-invoicing", router: electronicInvoiceReportingRoutes },
])
router.use("/factures", facturesRoutes);
router.use("/avoirs", avoirsRoutes);
router.use("/paiements", paiementsRoutes);
router.use("/proformas", proformaRoutes);
router.use("/tarification", tarificationRoutes);
router.use("/reporting", reportingRoutes);
router.use("/adv-reminders", reminderRoutes);
router.use("/margins", marginEngineRoutes);
router.use("/accounting-exports", accountingExportRoutes);
router.use("/supplier-invoices", supplierInvoiceRoutes);
// Suivi et pointage de production 360 (#274) monté AVANT le routeur historique :
// ses routes déclarent des capacités fines (refus par défaut) et exigent une
// clé d'idempotence. Le routeur hérité reste inchangé pour les écrans existants.
mountOrderedRouteGroup(router, [
  { prefix: "/production/execution", router: productionExecutionRoutes },
  // Poste opérateur tablette (#159) monté AVANT le routeur historique. Il ne
  // duplique aucune commande d'exécution : il ajoute appareil, session, file de
  // travail, dossier OF numérique et transmission de poste.
  { prefix: "/production/station", router: productionStationRoutes },
  // Versioning d'OF, replanification, AR client et document (#370), monté AVANT le
  // routeur historique. Il ne duplique aucune commande existante : il ajoute les
  // révisions, le VISA de phase, la dérive de temps, le brouillon de planning, le
  // dossier d'AR à recaler et le document d'OF figé.
  { prefix: "/production/of-versioning", router: ofVersioningRoutes },
  // Centre guidé de préparation : lecture des prérequis et calendriers audités.
  // Monté avant le routeur historique pour conserver une frontière RBAC dédiée.
  { prefix: "/production/readiness", router: productionReadinessRoutes },
  { prefix: "/production", router: productionRoutes },
])
router.use("/planning", planningRoutes);
router.use("/programmations", programmationRoutes);
// Qualité 360 (#228) monté AVANT le routeur historique : ses routes déclarent
// des capacités fines et ne doivent pas hériter du garde global hérité.
mountOrderedRouteGroup(router, [
  { prefix: "/qualite/v2", router: quality360Routes },
  { prefix: "/qualite", router: qualiteRoutes },
])
router.use("/livraisons", livraisonsRoutes);
router.use("/stock", stockRoutes);
router.use("/dossiers", operationDossiersRoutes);
router.use("/fournisseurs", fournisseursRoutes);
mountOrderedRouteGroup(router, [
  { prefix: "/commandes-fournisseurs", router: intercompanyPurchaseTrackingRoutes },
  { prefix: "/commandes-fournisseurs", router: commandeFournisseurRoutes }, // Module « Commandes fournisseurs » (#172) — BCF
])
router.use("/subcontract-work-packages", subcontractRoutes); // #626
router.use("/procurement-reliability", procurementReliabilityRoutes); // SOL-18 — scorecards et rapprochement achats
router.use("/replenishment-proposals", replenishmentProposalRoutes); // FEAT-CERP-0003 — suggestions sans achat automatique
router.use("/receptions", receptionsRoutes);
// Métrologie 360 (#229) monté AVANT le routeur historique : ses routes
// déclarent des capacités fines (refus par défaut) et ne partagent pas les
// chemins hérités, qui restent inchangés pour les écrans en production.
mountOrderedRouteGroup(router, [
  { prefix: "/metrologie/v2", router: metrology360Routes },
  { prefix: "/metrologie", router: metrologieRoutes },
])
router.use("/codes", codesRoutes);
router.use("/notifications", notificationsRoutes);
router.use("/chat", chatRoutes);
router.use("/users", usersRoutes);
// Traçabilité 360 (#142) : la surface étendue est montée AVANT le routeur
// historique pour que `/traceability/v2/...` ne soit jamais capté par lui.
mountOrderedRouteGroup(router, [
  { prefix: "/traceability/identification", router: identificationRoutes },
  { prefix: "/traceability/v2", router: traceability360Routes },
  { prefix: "/traceability", router: traceabilityRoutes },
])
router.use("/asbuilt", asbuiltRoutes)
router.use("/locks", locksRoutes)
mountOrderedRouteGroup(router, [
  { prefix: "/time-clock", router: tempsDeplacementsRoutes }, // Module « Temps & Déplacements » (RH pointage/kilomètres)
])
router.use("/project-office", projectOfficeRoutes) // Module « Project Office » (#130) — feature gate PROJECT_OFFICE fail-closed
// GED centrale (ADR-0037). Additif : aucun module existant n'est rebranché.
// Si le patch 20260727_ged_core n'est pas appliqué, ces routes répondent
// 503 GED_NOT_INSTALLED sans affecter le reste de l'API.
router.use("/ged", gedRoutes)
router.use("/import-assistant", importAssistantRoutes) // CLIPPER -> CERP staged import assistant (#167)
router.use("/data-cutover", dataCutoverRoutes) // Private preparation; business posting remains a separate cutover.
export default router
