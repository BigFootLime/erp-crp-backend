// src/routes/v1.routes.ts
import { Router } from "express"
import authRoutes from "../module/auth/routes/auth.routes"
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
import tarificationRoutes from "../module/facturation/routes/tarification.routes";
import reportingRoutes from "../module/facturation/routes/reporting.routes";
import productionRoutes from "../module/production/routes/production.routes";

const router = Router()

router.use("/auth", authRoutes)
router.use("/outils", outilRoutes)
router.use("/banking-info", bankingInfoRoutes)  
router.use("/commandes", commandeClientRoutes) // ✅  
router.use("/clients", clientRoutes);
router.use("/payment-modes", paymentModeRoutes);  
router.use("/billers", billerRoutes);   
router.use("/pieces-families", piecesfamiliesRoutes) 
router.use("/centre-frais", CFRoutes)     
router.use("/pieces-techniques", piecesTechniquesRoutes)
router.use("/audit-logs", auditLogsRoutes)
router.use("/admin", adminRoutes);
router.use("/affaires", affaireRoutes);
router.use("/devis", devisRoutes);
router.use("/factures", facturesRoutes);
router.use("/avoirs", avoirsRoutes);
router.use("/paiements", paiementsRoutes);
router.use("/tarification", tarificationRoutes);
router.use("/reporting", reportingRoutes);
router.use("/production", productionRoutes);
export default router
