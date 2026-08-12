import { Router } from "express";
import { commercialOutstanding, commercialRevenue, commercialTopClients } from "../controllers/reporting.controller";
import { directionDashboardOverview } from "../controllers/direction-dashboard.controller";
import {
  reportingClients,
  reportingDefinitions,
  reportingDeliveries,
  reportingDrilldown,
  reportingExport,
  reportingInvoicing,
  reportingOrders,
  reportingOverview,
  reportingQuotes,
  reportingReceivables,
} from "../controllers/reporting-v2.controller";
import { requireFinanceCapability } from "../middlewares/finance-authorization.middleware";
import commercialReliabilityRoutes from "../../commercial-reliability/routes/commercial-reliability.routes";

const router = Router();

// SOL-17 — projection commerciale transverse et commandes sensibles auditables.
// Montée sous /reporting pour réutiliser la frontière module existante, avec RBAC
// d'action supplémentaire sur chaque mutation.
router.use("/commercial/reliability", commercialReliabilityRoutes);

// --- Surface historique (#227), conservée pour ses consommateurs ---------------
// Contrat inchangé ; les agrégats sous-jacents ont été corrigés par #275.
router.get("/commercial/revenue", requireFinanceCapability("reporting_read"), commercialRevenue);
router.get("/commercial/outstanding", requireFinanceCapability("reporting_read"), commercialOutstanding);
router.get("/commercial/top-clients", requireFinanceCapability("reporting_read"), commercialTopClients);

// --- Reporting commercial 360 (#275) -----------------------------------------
// Refus par défaut à deux niveaux : la route exige la capacité minimale, le service
// re-vérifie la capacité exacte de chaque bloc. Masquer un bouton n'autorise rien.
const v2 = Router();
v2.get("/overview", requireFinanceCapability("reporting_read"), reportingOverview);
v2.get("/quotes", requireFinanceCapability("reporting_read"), reportingQuotes);
v2.get("/orders", requireFinanceCapability("reporting_read"), reportingOrders);
v2.get("/deliveries", requireFinanceCapability("reporting_read"), reportingDeliveries);
v2.get("/invoicing", requireFinanceCapability("reporting_financial"), reportingInvoicing);
v2.get("/receivables", requireFinanceCapability("reporting_financial"), reportingReceivables);
v2.get("/clients", requireFinanceCapability("reporting_client_detail"), reportingClients);
v2.get("/definitions", requireFinanceCapability("reporting_read"), reportingDefinitions);
v2.get("/drilldown", requireFinanceCapability("reporting_read"), reportingDrilldown);
v2.get("/export", requireFinanceCapability("reporting_export"), reportingExport);

router.use("/commercial/v2", v2);

// --- Cockpit Direction ARIANE (SOL-16) ------------------------------------
// Les montants et le détail nominatif imposent la capacité financière ; le
// frontend n'est jamais la frontière d'autorisation.
router.get(
  "/direction/overview",
  requireFinanceCapability("reporting_financial"),
  directionDashboardOverview
);

export default router;
